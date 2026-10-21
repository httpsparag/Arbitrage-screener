// Stage A connection check: login -> instrument master -> universe -> sample quotes -> engine.
// Run with: npm run check:angel -w @arb/worker

import { join } from 'node:path';
import {
  computeOpportunity,
  DEFAULT_CALC_CONFIG,
  istDate,
  istMinutes,
  CASH_CONTINUOUS_END_MINUTES,
  MARKET_OPEN_MINUTES,
  type Quote,
} from '@arb/core';
import { ConfigError, loadAngelConfig, mask } from '../config';
import { AngelApiError, AngelClient } from '../providers/angel/client';
import { toCoreQuote } from '../providers/angel/quotes';
import { buildUniverse, loadScripMaster } from '../providers/angel/scripMaster';

const SAMPLE_SYMBOLS = ['RELIANCE', 'HDFCBANK', 'INFY', 'SBIN', 'TCS'];
const CACHE = join(process.cwd(), 'data', 'OpenAPIScripMaster.json');

const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const info = (msg: string) => console.log(`    ${msg}`);
const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const rs = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

function marketOpen(now: number): boolean {
  const day = new Date(now + 330 * 60_000).getUTCDay();
  const m = istMinutes(now);
  return day >= 1 && day <= 5 && m >= MARKET_OPEN_MINUTES && m < CASH_CONTINUOUS_END_MINUTES;
}

async function main() {
  console.log('Angel One SmartAPI connection check');

  step(1, 'Reading configuration');
  const cfg = loadAngelConfig();
  ok(`Client code ${mask(cfg.clientCode)}, API key ${mask(cfg.apiKey)}, TOTP secret loaded (${cfg.totpSecret.length} chars)`);

  step(2, 'Logging in with TOTP');
  const client = new AngelClient(cfg);
  const session = await client.login();
  ok('Login successful');
  info(`Session token: yes, feed token for live streaming: ${session.feedToken ? 'yes' : 'NO'}`);

  try {
    step(3, 'Loading instrument master');
    const master = await loadScripMaster(CACHE);
    ok(`${master.rows.length.toLocaleString('en-IN')} instruments (${master.source}, ${master.fetchedOn})`);

    step(4, 'Building stock-futures universe');
    const now = Date.now();
    const universe = buildUniverse(master.rows, now);
    const byExpiry = new Map<string, number>();
    for (const c of universe.contracts) byExpiry.set(c.expiry, (byExpiry.get(c.expiry) ?? 0) + 1);
    ok(`${new Set(universe.contracts.map((c) => c.symbol)).size} stocks, ${universe.contracts.length} futures contracts`);
    for (const [e, n] of [...byExpiry].sort()) info(`expiry ${e}: ${n} contracts`);
    const reasons = new Map<string, number>();
    for (const s of universe.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [r, n] of reasons) info(`skipped ${n}: ${r}`);
    const tokens = new Set(universe.contracts.flatMap((c) => [c.cashToken, c.futToken]));
    info(`Instruments to stream: ${tokens.size}`);

    step(5, `Fetching sample quotes (${SAMPLE_SYMBOLS.join(', ')}, nearest expiry)`);
    const open = marketOpen(now);
    info(open ? 'Market is open.' : 'Market is closed — prices are from the last session, so depth may be empty.');
    const sample = SAMPLE_SYMBOLS.map((s) => universe.contracts.find((c) => c.symbol === s)).filter(
      (c): c is NonNullable<typeof c> => !!c,
    );
    const res = await client.quotes({
      NSE: sample.map((c) => c.cashToken),
      NFO: sample.map((c) => c.futToken),
    });
    const receivedAt = Date.now();
    ok(`${res.fetched.length} quotes received, ${res.unfetched.length} unfetched`);
    if (res.fetched[0]) info(`Quote fields: ${Object.keys(res.fetched[0]).join(', ')}`);
    const quotes = new Map<string, Quote>(
      res.fetched.map((q) => [String(q.symbolToken), toCoreQuote(q, receivedAt, 'snapshot')]),
    );

    step(6, 'Running the calculation engine (bid/ask mode, 1 lot, snapshot data → research only)');
    for (const c of sample) {
      const o = computeOpportunity({
        contract: c,
        cashQuote: quotes.get(c.cashToken),
        futQuote: quotes.get(c.futToken),
        now: receivedAt,
        config: DEFAULT_CALC_CONFIG,
      });
      const q = o.quotes;
      console.log(`\n  ${c.symbol}  ${c.futTradingSymbol}  lot ${c.lotSize}  expiry ${c.expiry} (${o.daysToExpiry}d)`);
      info(`Cash   LTP ${rs(q.cashLtp)}  bid ${rs(q.cashBid)}  ask ${rs(q.cashAsk)}`);
      info(`Future LTP ${rs(q.futLtp)}  bid ${rs(q.futBid)}  ask ${rs(q.futAsk)}  OI ${rs(q.openInterest, 0)}`);
      info(`LTP basis ${rs(o.ltpGrossSpread)} per share`);
      if (o.economics) {
        const e = o.economics;
        info(
          `Gross ₹${rs(e.grossSpreadValuePerLot)}/lot − costs ₹${rs(e.costs.total)} − funding ₹${rs(e.fundingCost)} = net ₹${rs(e.netProfitPerLot)}/lot` +
            `  (${rs(e.netReturnPct, 3)}%, ${e.annualizedYieldPct === null ? 'n/a' : rs(e.annualizedYieldPct) + '% p.a.'})`,
        );
      }
      info(`Status: ${o.status.toUpperCase()}${o.exclusionReasons.length ? ' — ' + o.exclusionReasons.join(', ') : ''}`);
    }
  } finally {
    step(7, 'Logging out');
    await client.logout().catch(() => undefined);
    ok('Done');
  }
  console.log(`\nCheck completed ${istDate(Date.now())}. Stage A connection works.`);
}

main().catch((err: unknown) => {
  console.error('\n  ✘ Check failed:');
  if (err instanceof ConfigError) {
    console.error(`    ${err.message}`);
  } else if (err instanceof AngelApiError) {
    console.error(`    Angel One said: "${err.message}" (code ${err.errorCode ?? 'n/a'}, HTTP ${err.httpStatus})`);
    const m = err.message.toLowerCase();
    if (m.includes('totp')) console.error('    Hint: check ANGEL_TOTP_SECRET and that your PC clock is correct.');
    else if (m.includes('api key') || m.includes('apikey')) console.error('    Hint: check ANGEL_API_KEY.');
    else if (m.includes('ip')) console.error('    Hint: the request IP may not match the static IP registered on your SmartAPI app.');
    else if (m.includes('password') || m.includes('pin') || m.includes('credential')) console.error('    Hint: check ANGEL_CLIENT_CODE and ANGEL_PIN.');
  } else {
    console.error(`    ${(err as Error).message}`);
  }
  process.exitCode = 1;
});
