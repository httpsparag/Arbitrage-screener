// Angel One's public instrument master: builds the stock-futures universe
// (each FUTSTK contract paired with its NSE cash instrument).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { istDate, SCRIP_MASTER_URL, type ScripRow } from '@arb/core';

export { buildUniverse, parseExpiry, SCRIP_MASTER_URL, type ScripRow, type UniverseResult } from '@arb/core';

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
