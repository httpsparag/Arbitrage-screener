// Daily contract-list refresh: streams Angel One's ~36 MB instrument master, keeps only stock
// futures and their NSE cash instruments, and updates the `contracts` table.
// Streaming keeps memory and CPU within Edge Function limits.

import * as core from "../_shared/core.js";
import { authorize, check, CORS, serviceClient } from "../_shared/db.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type ScripRow = Record<string, string>;
interface Contract {
  symbol: string; name: string; cashToken: string; cashTradingSymbol: string; futToken: string;
  futTradingSymbol: string; expiry: string; lotSize: number; tickSize: number; status: string;
}

const keep = (obj: string) =>
  (obj.includes('"FUTSTK"') && obj.includes('"NFO"')) || (obj.includes('-EQ"') && obj.includes('"exch_seg":"NSE"'));

async function loadRows(): Promise<ScripRow[]> {
  const res = await fetch(core.SCRIP_MASTER_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`Instrument master download failed: HTTP ${res.status}`);
  const rows: ScripRow[] = [];
  let buf = "";
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let start = buf.indexOf("{");
    let consumed = 0;
    while (start !== -1) {
      const end = buf.indexOf("}", start);
      if (end === -1) break;
      const obj = buf.slice(start, end + 1);
      if (keep(obj)) rows.push(JSON.parse(obj));
      consumed = end + 1;
      start = buf.indexOf("{", consumed);
    }
    buf = start === -1 ? "" : buf.slice(start);
  }
  return rows;
}

async function refresh(): Promise<{ contracts: number; stocks: number; skipped: number }> {
  const db = serviceClient();
  const now = Date.now();
  const rows = await loadRows();
  const { contracts, skipped } = core.buildUniverse(rows, now) as { contracts: Contract[]; skipped: unknown[] };
  if (contracts.length < 100) throw new Error(`Only ${contracts.length} contracts parsed; refusing to replace the list`);

  const stamp = new Date().toISOString();
  const payload = contracts.map((c: Contract) => ({
    fut_token: c.futToken,
    symbol: c.symbol,
    name: c.name,
    cash_token: c.cashToken,
    cash_trading_symbol: c.cashTradingSymbol,
    fut_trading_symbol: c.futTradingSymbol,
    expiry: c.expiry,
    lot_size: c.lotSize,
    tick_size: c.tickSize,
    status: "active",
    updated_at: stamp,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    await check("contracts upsert", db.from("contracts").upsert(payload.slice(i, i + 500)));
  }
  // Anything not in today's list (expired or delisted) is no longer active.
  await check("contracts retire", db.from("contracts").update({ status: "expired" }).lt("updated_at", stamp).eq("status", "active"));

  const stocks = new Set(contracts.map((c: Contract) => c.symbol)).size;
  await check(
    "status",
    db.from("scanner_status").update({ universe_refreshed_at: stamp, contracts: contracts.length, message: `Contract list refreshed: ${stocks} stocks, ${contracts.length} contracts` }).eq("id", 1),
  );
  return { contracts: contracts.length, stocks, skipped: skipped.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = serviceClient();
  if (!(await authorize(req, db))) return new Response("forbidden", { status: 403, headers: CORS });
  const job = refresh().catch(async (e) => {
    await db.from("scanner_status").update({ last_error: `Contract refresh: ${(e as Error).message}`, last_error_at: new Date().toISOString() }).eq("id", 1);
  });
  EdgeRuntime.waitUntil(job);
  return Response.json({ accepted: true }, { status: 202, headers: CORS });
});
