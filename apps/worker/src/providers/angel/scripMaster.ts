// Angel One's public instrument master: builds the stock-futures universe
// (each FUTSTK contract paired with its NSE cash instrument).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { daysBetween, isExpired, istDate, type Contract } from '@arb/core';

export const SCRIP_MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

export interface ScripRow {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
}

/** Stock futures are listed at most ~3 months out; anything further is a test/dummy row. */
const MAX_EXPIRY_DAYS = 120;

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** "27OCT2026" -> "2026-10-27"; null if the format is unexpected. */
export function parseExpiry(raw: string): string | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(raw.trim().toUpperCase());
  if (!m || !MONTHS[m[2]!]) return null;
  return `${m[3]}-${MONTHS[m[2]!]}-${m[1]}`;
}

export interface UniverseResult {
  contracts: Contract[];
  skipped: { row: ScripRow; reason: string }[];
  builtAt: number;
}

export function buildUniverse(rows: readonly ScripRow[], now: number): UniverseResult {
  const today = istDate(now);
  const cashByName = new Map<string, ScripRow>();
  for (const r of rows) {
    if (r.exch_seg === 'NSE' && r.symbol.endsWith('-EQ')) cashByName.set(r.name, r);
  }
  const contracts: Contract[] = [];
  const skipped: UniverseResult['skipped'] = [];
  for (const r of rows) {
    if (r.exch_seg !== 'NFO' || r.instrumenttype !== 'FUTSTK') continue;
    const expiry = parseExpiry(r.expiry);
    const lotSize = Number(r.lotsize);
    const cash = cashByName.get(r.name);
    let reason: string | null = null;
    if (!expiry) reason = `unparseable expiry "${r.expiry}"`;
    else if (isExpired(expiry, now)) reason = 'expired';
    else if (daysBetween(today, expiry) > MAX_EXPIRY_DAYS) reason = 'expiry too far out (test/dummy contract)';
    else if (/NSETEST/i.test(r.name)) reason = 'exchange test instrument';
    else if (!Number.isInteger(lotSize) || lotSize <= 0) reason = `invalid lot size "${r.lotsize}"`;
    else if (!cash) reason = 'no matching NSE cash instrument';
    if (reason) {
      skipped.push({ row: r, reason });
      continue;
    }
    contracts.push({
      symbol: r.name,
      name: r.name,
      cashToken: cash!.token,
      cashTradingSymbol: cash!.symbol,
      futToken: r.token,
      futTradingSymbol: r.symbol,
      expiry: expiry!,
      lotSize,
      // The master stores tick size in paise.
      tickSize: Number(r.tick_size) / 100,
      status: 'active',
    });
  }
  contracts.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.expiry.localeCompare(b.expiry));
  return { contracts, skipped, builtAt: now };
}

/**
 * Loads the scrip master, downloading at most once per IST day and caching it locally.
 * Falls back to the cached copy if the download fails.
 */
export async function loadScripMaster(cachePath: string, now = Date.now()): Promise<{
  rows: ScripRow[];
  source: 'download' | 'cache';
  fetchedOn: string;
}> {
  const today = istDate(now);
  const cachedOn = await stat(cachePath)
    .then((s) => istDate(s.mtimeMs))
    .catch(() => null);
  if (cachedOn !== today) {
    try {
      const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = JSON.parse(text) as ScripRow[];
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, text);
      return { rows, source: 'download', fetchedOn: today };
    } catch (err) {
      if (!cachedOn) throw new Error(`Could not download scrip master: ${(err as Error).message}`);
    }
  }
  const rows = JSON.parse(await readFile(cachePath, 'utf8')) as ScripRow[];
  return { rows, source: 'cache', fetchedOn: cachedOn! };
}
