// Diagnostic: stream for N seconds, then compare the best-ranked rows' streamed quotes with REST quotes.
import { join } from 'node:path';
import { computeOpportunity, DEFAULT_CALC_CONFIG, rankOpportunities } from '@arb/core';
import { loadAngelConfig } from '../config';
import { AngelClient } from '../providers/angel/client';
import { toCoreQuote } from '../providers/angel/quotes';
import { buildUniverse, loadScripMaster } from '../providers/angel/scripMaster';
import { AngelStreamProvider } from '../providers/angel/stream';
import type { Instrument } from '../providers/Provider';
import { QuoteStore } from '../quoteStore';

const seconds = Number(process.argv[2] ?? 70);

async function main() {
  const cfg = loadAngelConfig();
  const client = new AngelClient(cfg);
  await client.login();
  const master = await loadScripMaster(join(process.cwd(), 'data', 'OpenAPIScripMaster.json'));
  const { contracts } = buildUniverse(master.rows, Date.now());
  const cashTokens = new Set(contracts.map((c) => c.cashToken));
  const futTokens = new Set(contracts.map((c) => c.futToken));
  console.log('token collisions between NSE cash and NFO futures:', [...cashTokens].filter((t) => futTokens.has(t)));

  const inst = new Map<string, Instrument>();
  for (const c of contracts) {
    inst.set('C' + c.cashToken, { token: c.cashToken, exchange: 'NSE' });
    inst.set('F' + c.futToken, { token: c.futToken, exchange: 'NFO' });
  }
  const store = new QuoteStore();
  const seen = new Map<string, Set<number>>();
  const feed = new AngelStreamProvider(client, cfg);
  feed.onQuote((q) => store.upsert(q));
  await feed.start([...inst.values()]);
  for (let t = 0; t < seconds; t += 10) {
    await new Promise((r) => setTimeout(r, 10_000));
    const now = Date.now();
    const opps = contracts.map((c) =>
      computeOpportunity({ contract: c, cashQuote: store.get(c.cashToken, now), futQuote: store.get(c.futToken, now), now, config: DEFAULT_CALC_CONFIG }),
    );
    const top = rankOpportunities(opps.filter((o) => o.economics), 'yieldAfterCosts')[0]!.opportunity;
    console.log(`${t + 10}s top: ${top.contract.symbol} ${top.contract.expiry} ${top.economics!.annualizedYieldBeforeFundingPct!.toFixed(2)}% p.a.`);
  }
  const now = Date.now();
  const opps = contracts.map((c) =>
    computeOpportunity({ contract: c, cashQuote: store.get(c.cashToken, now), futQuote: store.get(c.futToken, now), now, config: DEFAULT_CALC_CONFIG }),
  );
  const top = rankOpportunities(opps.filter((o) => o.economics), 'yieldAfterCosts').slice(0, 4).map((r) => r.opportunity);
  await feed.stop();
  const rest = await client.quotes({ NSE: top.map((o) => o.contract.cashToken), NFO: top.map((o) => o.contract.futToken) });
  const restMap = new Map(rest.fetched.map((q) => [`${q.exchange}:${q.symbolToken}`, toCoreQuote(q, now, 'snapshot')]));
  for (const o of top) {
    const c = o.contract;
    const sc = store.get(c.cashToken, now)!;
    const sf = store.get(c.futToken, now)!;
    const rc = restMap.get(`NSE:${c.cashToken}`);
    const rf = restMap.get(`NFO:${c.futToken}`);
    const lv = (l: { price: number; quantity: number }[]) => l.map((x) => `${x.price}x${x.quantity}`).join(' ');
    console.log(`\n${c.symbol} ${c.expiry} cashTok=${c.cashToken} futTok=${c.futToken}  yield ${o.economics!.annualizedYieldBeforeFundingPct!.toFixed(2)}%`);
    console.log(`  STREAM cash ltp ${sc.ltp} bids ${lv(sc.bids)} | asks ${lv(sc.asks)}`);
    console.log(`  REST   cash ltp ${rc?.ltp} bids ${lv(rc?.bids ?? [])} | asks ${lv(rc?.asks ?? [])}`);
    console.log(`  STREAM fut  ltp ${sf.ltp} bids ${lv(sf.bids)} | asks ${lv(sf.asks)}`);
    console.log(`  REST   fut  ltp ${rf?.ltp} bids ${lv(rf?.bids ?? [])} | asks ${lv(rf?.asks ?? [])}`);
  }
  await client.logout();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
