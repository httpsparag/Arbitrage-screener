// Builds the closing-prices view on demand from Angel One REST quotes (after the close),
// for days the worker was not running at the close.
// Run with: npm run close:snapshot -w @arb/worker

import { join } from 'node:path';
import { istMinutes, FO_CLOSE_MINUTES, isWeekday, type Quote } from '@arb/core';
import { loadAngelConfig } from '../config';
import { AngelClient } from '../providers/angel/client';
import { toCoreQuote } from '../providers/angel/quotes';
import { buildUniverse, loadScripMaster } from '../providers/angel/scripMaster';
import { buildCloseMessage } from '../closeSnapshot';
import { MarginBook } from '../margins';
import { loadSupabaseConfig, Publisher } from '../publisher';
import { WORKER_VERSION } from '../service';

async function main() {
  const now = Date.now();
  if (isWeekday(now) && istMinutes(now) >= 9 * 60 && istMinutes(now) < FO_CLOSE_MINUTES) {
    console.warn('! The market is still open; closing prices are only final after 15:40 IST.');
  }
  const client = new AngelClient(loadAngelConfig());
  const publisher = new Publisher(loadSupabaseConfig());
  await client.login();
  try {
    const master = await loadScripMaster(join(process.cwd(), 'data', 'OpenAPIScripMaster.json'));
    const { contracts } = buildUniverse(master.rows, now);
    const cash = [...new Set(contracts.map((c) => c.cashToken))];
    const fut = contracts.map((c) => c.futToken);
    console.log(`Fetching closing quotes for ${cash.length + fut.length} instruments (about ${Math.ceil((cash.length + fut.length) / 50)} requests)…`);
    const res = await client.quotes({ NSE: cash, NFO: fut }, 'FULL');
    const receivedAt = Date.now();
    const quotes = new Map<string, Quote>();
    for (const q of res.fetched) quotes.set(`${q.exchange}:${q.symbolToken}`, toCoreQuote(q, receivedAt, 'eod'));
    console.log(`✔ ${res.fetched.length} quotes, ${res.unfetched.length} unfetched`);

    // Broker margins: today's cache from the worker, or fetch them (about 4 minutes) with --margins.
    const margins = new MarginBook(join(process.cwd(), 'data', 'margins.json'));
    const cached = await margins.loadCache();
    if (process.argv.includes('--margins') || !cached) {
      if (!process.argv.includes('--margins')) {
        console.log('No margins cached today; using the estimate. Add --margins to fetch broker margins (~4 min).');
      } else {
        console.log(`Fetching broker margins for ${contracts.length} contracts (~${Math.ceil((contracts.length * 0.5) / 60)} min)…`);
        const r = await margins.refresh(client, contracts, (t) => quotes.get(`NFO:${t}`)?.ltp ?? null);
        console.log(`✔ Margins: ${r.updated} updated, ${r.failed} failed, ${r.skipped} without price`);
      }
    } else console.log(`Using ${margins.size} broker margins cached today`);

    const settingsRaw = (await publisher.readUserSettings()) ?? {};
    const exchangeOf = new Map<string, 'NSE' | 'NFO'>();
    for (const c of contracts) {
      exchangeOf.set(c.cashToken, 'NSE');
      exchangeOf.set(c.futToken, 'NFO');
    }
    const msg = buildCloseMessage({
      contracts,
      quote: (t) => quotes.get(`${exchangeOf.get(t)}:${t}`),
      marginRate: (t) => margins.rate(t),
      now: receivedAt,
      settingsRaw,
      feed: {
        provider: 'Angel One SmartAPI (REST quotes)',
        dataKind: 'eod',
        state: 'idle',
        lastTickAt: null,
        lastMessageAt: receivedAt,
        subscribed: 0,
        reconnects: 0,
        lastError: null,
        session: 'closed',
      },
      version: WORKER_VERSION,
    });
    await publisher.writeCloseSnapshot(msg);
    const priced = msg.rows.filter((r) => r.m[0] !== null);
    const positive = priced.filter((r) => (r.m[0] ?? 0) > 0);
    console.log(`✔ Closing-prices snapshot saved for ${msg.tradeDate}: ${priced.length} contracts priced, ${positive.length} positive after costs.`);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`✘ ${(err as Error).message}`);
  process.exitCode = 1;
});
