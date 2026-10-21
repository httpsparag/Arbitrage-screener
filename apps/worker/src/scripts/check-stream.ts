// Stage A/D check: streams every eligible cash + futures instrument for a short window,
// then runs the engine over the whole universe and prints the ranked result.
// Run with: npm run check:stream -w @arb/worker [-- seconds]

import { join } from 'node:path';
import {
  computeOpportunity,
  DEFAULT_CALC_CONFIG,
  rankOpportunities,
  summarize,
  type Opportunity,
} from '@arb/core';
import { loadAngelConfig } from '../config';
import { AngelClient } from '../providers/angel/client';
import { buildUniverse, loadScripMaster } from '../providers/angel/scripMaster';
import { AngelStreamProvider } from '../providers/angel/stream';
import type { Instrument } from '../providers/Provider';
import { QuoteStore } from '../quoteStore';

const seconds = Number(process.argv[2] ?? 30);
const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

async function main() {
  const cfg = loadAngelConfig();
  const client = new AngelClient(cfg);
  await client.login();
  console.log('✔ Logged in');

  const master = await loadScripMaster(join(process.cwd(), 'data', 'OpenAPIScripMaster.json'));
  const { contracts } = buildUniverse(master.rows, Date.now());
  const instruments = new Map<string, Instrument>();
  for (const c of contracts) {
    instruments.set(c.cashToken, { token: c.cashToken, exchange: 'NSE' });
    instruments.set(c.futToken, { token: c.futToken, exchange: 'NFO' });
  }
  console.log(`✔ Universe: ${contracts.length} contracts, ${instruments.size} instruments`);

  const store = new QuoteStore();
  const feed = new AngelStreamProvider(client, cfg);
  feed.onQuote((q) => store.upsert(q));
  feed.onStatus((s) => {
    if (s.state !== 'connected' || s.lastError) console.log(`  feed: ${s.state}${s.lastError ? ' — ' + s.lastError : ''}`);
  });
  await feed.start([...instruments.values()]);

  const started = Date.now();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const s = feed.status();
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(
        `  ${elapsed}s  state=${s.state}  ticks=${feed.ticks}  instruments with data=${store.size}/${instruments.size}`,
      );
      if (elapsed >= seconds) {
        clearInterval(timer);
        resolve();
      }
    }, 5000);
  });

  const now = Date.now();
  const last = feed.status().lastMessageAt;
  const opps: Opportunity[] = contracts.map((c) =>
    computeOpportunity({
      contract: c,
      cashQuote: store.get(c.cashToken, last),
      futQuote: store.get(c.futToken, last),
      now,
      config: DEFAULT_CALC_CONFIG,
    }),
  );
  await feed.stop();
  await client.logout().catch(() => undefined);

  const s = summarize(opps);
  console.log(`\nScan: ${s.stocks} stocks, ${s.contracts} contracts`);
  console.log(`  profitable after costs: ${s.executable}   of which beat the 7% funding rate: ${s.beatingFundingRate}`);
  console.log(`  unprofitable: ${s.unprofitable}   excluded: ${s.excluded} (stale ${s.stale})`);
  const reasons = new Map<string, number>();
  for (const o of opps) for (const r of o.exclusionReasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  for (const [r, n] of reasons) console.log(`    excluded ${n}: ${r}`);

  const priced = opps.filter((o) => o.economics);
  console.log('\nTop 15 by est. net yield after costs (bid/ask, 1 lot, square-off at expiry):');
  console.log('  #  symbol        expiry      days  cash ask   fut bid    gross/lot   costs     net/lot  yield%   vs 7%   quality');
  for (const r of rankOpportunities(priced, 'yieldAfterCosts').slice(0, 15)) {
    const o = r.opportunity;
    const e = o.economics!;
    console.log(
      `  ${String(r.rank).padStart(2)} ${o.contract.symbol.padEnd(13)} ${o.contract.expiry}  ${String(o.daysToExpiry).padStart(3)}  ` +
        `${fmt(e.cashBuyPrice).padStart(9)} ${fmt(e.futSellPrice).padStart(9)}  ${fmt(e.grossSpreadValuePerLot).padStart(10)} ` +
        `${fmt(e.costs.total).padStart(8)} ${fmt(e.netProfitPerLotBeforeFunding).padStart(10)} ` +
        `${fmt(e.annualizedYieldBeforeFundingPct).padStart(7)} ${fmt(e.annualizedYieldPct).padStart(7)}   ${fmt(o.quality?.score ?? null, 0)}  ${o.status}`,
    );
  }
}

main().catch((err) => {
  console.error('✘', (err as Error).message);
  process.exitCode = 1;
});
