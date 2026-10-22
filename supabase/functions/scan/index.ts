// Cloud scanner. Supabase Cron calls this every minute in market hours (or the phone calls it
// via "Scan now"). Each call: log in to Angel One if needed, fetch all cash + futures quotes,
// run the shared calculation engine, publish to the dashboard, refresh some broker margins,
// record basis history, and after the close save the closing-prices view.

import * as core from "../_shared/core.js";
import { AngelError, futuresMargin, login, parseFeedTime, quotes as fetchQuotes, type FullQuote } from "../_shared/angel.ts";
import { authorize, check, CORS, serviceClient, SUPABASE_URL } from "../_shared/db.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const VERSION = "cloud-0.1.0";
/** Two scans per minutely call while the market is open → updates every ~30 s. */
const POLL_MS = 30_000;
/** Quotes are refreshed every 30 s, so allow a margin before calling them stale. */
const STALE_MS = 120_000;
const TOP_ROWS = 100;
const MARGINS_PER_RUN = 15;
const MARGIN_MAX_AGE_MS = 4 * 60 * 60_000;
const BASIS_BUCKET_MS = 5 * 60_000;
const HISTORY_RETENTION_MS = 8 * 86_400_000;
const PROVIDER = "Angel One SmartAPI (cloud, every 30 s)";

type Db = SupabaseClient;
type Action = "scan" | "close" | "relogin";
// The engine bundle is plain JS; these are the shapes this function relies on.
// deno-lint-ignore no-explicit-any
type Any = any;

interface Contract {
  symbol: string; name: string; cashToken: string; cashTradingSymbol: string; futToken: string;
  futTradingSymbol: string; expiry: string; lotSize: number; tickSize: number; status: string;
}

const iso = (t: number) => new Date(t).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function setStatus(db: Db, patch: Record<string, unknown>) {
  await db.from("scanner_status").update({ ...patch, poll_interval_ms: POLL_MS }).eq("id", 1);
}

function toQuote(q: FullQuote, receivedAt: number, dataKind: string) {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const levels = (l?: { price: number; quantity: number; orders: number }[]) =>
    (l ?? []).filter((x) => x.price > 0 && x.quantity > 0).map((x) => ({ price: +x.price, quantity: +x.quantity, orders: +x.orders || 0 }));
  const volume = num(q.tradeVolume);
  const avg = num(q.avgPrice);
  return {
    token: String(q.symbolToken),
    ltp: num(q.ltp) && num(q.ltp)! > 0 ? num(q.ltp) : null,
    bids: levels(q.depth?.buy),
    asks: levels(q.depth?.sell),
    volume,
    turnover: volume !== null && avg ? volume * avg : null,
    openInterest: q.exchange === "NFO" ? num(q.opnInterest) : null,
    exchangeTimestamp: parseFeedTime(q.exchFeedTime),
    receivedAt,
    tradable: true,
    dataKind,
  };
}

async function loadContracts(db: Db, today: string): Promise<Contract[]> {
  const rows = await check(
    "contracts",
    db.from("contracts").select("*").eq("status", "active").gte("expiry", today).order("symbol").limit(2000),
  ) as Record<string, Any>[];
  return rows.map((r) => ({
    symbol: r.symbol, name: r.name, cashToken: r.cash_token, cashTradingSymbol: r.cash_trading_symbol,
    futToken: r.fut_token, futTradingSymbol: r.fut_trading_symbol, expiry: r.expiry,
    lotSize: Number(r.lot_size), tickSize: Number(r.tick_size), status: "active",
  }));
}

/** Logged-in Angel session for today, logging in when needed. */
async function session(db: Db, today: string, force: boolean): Promise<string> {
  const s = (await check("session", db.from("scanner_session").select("angel_jwt,angel_login_date").eq("id", 1).single())) as Any;
  if (!force && s?.angel_jwt && s.angel_login_date === today) return s.angel_jwt;
  const fresh = await login();
  await check(
    "session save",
    db.from("scanner_session").update({ angel_jwt: fresh.jwt, angel_feed_token: fresh.feedToken, angel_login_date: today, angel_login_at: iso(Date.now()) }).eq("id", 1),
  );
  return fresh.jwt;
}

/** Fetches all quotes, re-logging in once if the session was rejected. */
async function getQuotes(db: Db, today: string, jwt: string, contracts: Contract[]) {
  const tokens = { NSE: [...new Set(contracts.map((c) => c.cashToken))], NFO: contracts.map((c) => c.futToken) };
  try {
    return { jwt, fetched: await fetchQuotes(jwt, tokens) };
  } catch (e) {
    if (!(e instanceof AngelError) || !e.isAuth) throw e;
    const fresh = await session(db, today, true);
    return { jwt: fresh, fetched: await fetchQuotes(fresh, tokens) };
  }
}

function quoteMap(fetched: FullQuote[], receivedAt: number, dataKind: string) {
  const m = new Map<string, Any>();
  for (const q of fetched) m.set(`${q.exchange}:${q.symbolToken}`, toQuote(q, receivedAt, dataKind));
  return m;
}

async function broadcast(event: string, payload: unknown) {
  const key = (Deno.env.get("ARB_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ topic: "screener", event, payload, private: true }] }),
  });
  if (!res.ok) throw new Error(`broadcast: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
}

function buildMessage(kind: "top" | "full" | "close", opps: Any[], qm: Map<string, Any>, ctx: {
  now: number; phase: string; settingsRaw: Record<string, unknown>; fetchedAt: number; tokens: number; tradeDate?: string;
}) {
  const s = core.summarize(opps);
  const withQty = (o: Any) =>
    core.withTopQuantities(core.toWireRow(o), qm.get(`NSE:${o.contract.cashToken}`), qm.get(`NFO:${o.contract.futToken}`));
  const chosen = kind === "top"
    ? core.rankOpportunities(opps.filter((o: Any) => o.economics), "yieldAfterCosts").slice(0, TOP_ROWS).map((r: Any) => r.opportunity)
    : opps;
  return {
    kind,
    tradeDate: ctx.tradeDate,
    at: ctx.now,
    version: VERSION,
    feed: {
      provider: PROVIDER,
      dataKind: kind === "close" ? "eod" : "live",
      state: "connected",
      lastTickAt: ctx.fetchedAt,
      lastMessageAt: ctx.fetchedAt,
      subscribed: ctx.tokens,
      reconnects: 0,
      lastError: null,
      session: ctx.phase,
      pollIntervalMs: POLL_MS,
    },
    summary: {
      stocks: s.stocks,
      contracts: s.contracts,
      executable: s.executable,
      beatingFundingRate: s.beatingFundingRate,
      unprofitable: s.unprofitable,
      research: s.research,
      excluded: s.excluded,
      stale: s.stale,
      passingQuality: s.passingQuality,
      bestYieldAfterCosts: s.bestAnnualizedYield?.value ?? null,
      bestNetProfitPerLot: s.bestNetProfitPerLot?.value ?? null,
    },
    settings: ctx.settingsRaw,
    rows: chosen.map(withQty),
  };
}

async function refreshMargins(db: Db, jwt: string, contracts: Contract[], qm: Map<string, Any>, known: Map<string, { rate: number; at: number }>) {
  const now = Date.now();
  const due = contracts
    .filter((c) => !known.has(c.futToken) || now - known.get(c.futToken)!.at > MARGIN_MAX_AGE_MS)
    .sort((a, b) => (known.get(a.futToken)?.at ?? 0) - (known.get(b.futToken)?.at ?? 0))
    .slice(0, MARGINS_PER_RUN);
  const rows: { fut_token: string; rate: number; fetched_at: string }[] = [];
  for (const c of due) {
    const price = qm.get(`NFO:${c.futToken}`)?.ltp;
    if (!price) continue;
    try {
      const rate = (await futuresMargin(jwt, c.futToken, c.lotSize)) / (price * c.lotSize);
      if (Number.isFinite(rate) && rate > 0 && rate < 1) {
        rows.push({ fut_token: c.futToken, rate, fetched_at: iso(Date.now()) });
        known.set(c.futToken, { rate, at: Date.now() });
      }
    } catch {
      // try again next run
    }
    await sleep(300);
  }
  if (rows.length) await db.from("contract_margins").upsert(rows);
}

async function sampleBasis(db: Db, contracts: Contract[], qm: Map<string, Any>, now: number) {
  const bucket = Math.floor(now / BASIS_BUCKET_MS) * BASIS_BUCKET_MS;
  const s = (await check("session", db.from("scanner_session").select("last_basis_bucket").eq("id", 1).single())) as Any;
  if (s?.last_basis_bucket && Date.parse(s.last_basis_bucket) >= bucket) return;
  const mid = (q: Any) => (q?.bids[0] && q?.asks[0] ? (q.bids[0].price + q.asks[0].price) / 2 : q?.ltp ?? null);
  const rows = [];
  for (const c of contracts) {
    const cash = mid(qm.get(`NSE:${c.cashToken}`));
    const fut = mid(qm.get(`NFO:${c.futToken}`));
    if (!cash || !fut) continue;
    rows.push({ fut_token: c.futToken, ts: iso(bucket), cash_price: cash, fut_price: fut, basis_pct: ((fut - cash) / cash) * 100 });
  }
  if (rows.length) await check("basis insert", db.from("basis_history").upsert(rows));
  await db.from("scanner_session").update({ last_basis_bucket: iso(bucket) }).eq("id", 1);
}

/** End of continuous trading: summarise the last open-market snapshot. */
async function writeSessionSummary(db: Db, today: string) {
  const snap = (await check("snapshot", db.from("screener_snapshot").select("payload").eq("id", 1).maybeSingle())) as Any;
  const rows: Any[] = snap?.payload?.rows ?? [];
  if (!rows.some((r) => r.st === "executable" || r.st === "unprofitable")) return;
  const top = rows.filter((r) => r.m?.[0] !== null && r.st !== "excluded").sort((a, b) => b.m[0] - a.m[0]).slice(0, 10);
  await db.from("session_summaries").upsert({
    trade_date: today,
    summary: { writtenAt: iso(Date.now()), source: "cloud", summary: snap.payload.summary, top: top.map((row) => ({ symbol: row.s, expiry: row.e, yieldAfterCosts: row.m[0], netProfitPerLot: row.m[2], status: row.st, row })) },
  });
}

async function writeClose(db: Db, jwt: string, today: string, contracts: Contract[], settingsRaw: Record<string, unknown>, margins: Map<string, { rate: number }>) {
  const { fetched } = await getQuotes(db, today, jwt, contracts);
  const now = Date.now();
  const qm = quoteMap(fetched, now, "eod");
  const config = { ...core.applySettings(settingsRaw), priceMode: "ltp", staleAfterMs: Number.MAX_SAFE_INTEGER };
  const opps = contracts.map((c) =>
    core.computeOpportunity({
      contract: c, cashQuote: qm.get(`NSE:${c.cashToken}`), futQuote: qm.get(`NFO:${c.futToken}`), now, config,
      marginRate: margins.get(c.futToken)?.rate ?? null,
    }),
  );
  const msg = buildMessage("close", opps, qm, { now, phase: "closed", settingsRaw, fetchedAt: now, tokens: fetched.length, tradeDate: today });
  await check("close snapshot", db.from("close_snapshots").upsert({ trade_date: today, taken_at: iso(now), payload: msg }));
  await db.rpc("rollup_basis_daily", { trade_day: today });
  await db.from("basis_history").delete().lt("ts", iso(now - HISTORY_RETENTION_MS));
  await db.from("scanner_session").update({ close_written_for: today }).eq("id", 1);
}

async function run(db: Db, scheduled: boolean, action: Action) {
  const { data: locked } = await db.rpc("scanner_try_lock", { seconds: 110 });
  if (!locked) return;
  const started = Date.now();
  try {
    const phase: string = core.sessionPhase(started);
    const today: string = core.istDate(started);
    const minutes: number = core.istMinutes(started);
    const control = (await check("control", db.from("scanner_control").select("*").eq("id", 1).single())) as Any;
    const sess = (await check("session", db.from("scanner_session").select("summary_written_for,close_written_for").eq("id", 1).single())) as Any;

    // Only the minutely schedule respects market hours and pauses; manual requests always run.
    if (scheduled) {
      if (!core.shouldRun(started)) {
        await setStatus(db, { state: "idle", phase, message: "Outside market hours", last_run_at: iso(started) });
        return;
      }
      if (control.paused_until && control.paused_until >= today) {
        await setStatus(db, { state: "paused", phase, message: `Paused until end of ${control.paused_until}`, last_run_at: iso(started) });
        return;
      }
    }

    const relogin = action === "relogin" || !!control.force_relogin;
    let jwt = await session(db, today, relogin);
    if (control.force_relogin) await db.from("scanner_control").update({ force_relogin: false }).eq("id", 1);
    if (action === "relogin") {
      await setStatus(db, { state: "running", phase, message: "Logged in to Angel One", last_run_at: iso(started), last_ok_at: iso(Date.now()) });
      return;
    }

    const contracts = await loadContracts(db, today);
    if (!contracts.length) throw new Error("No contracts loaded — tap “Refresh contract list”.");
    const settingsRow = (await db.from("user_settings").select("calc_config").order("updated_at", { ascending: false }).limit(1)).data?.[0] as Any;
    const settingsRaw: Record<string, unknown> = settingsRow?.calc_config ?? {};
    const marginRows = ((await db.from("contract_margins").select("fut_token,rate,fetched_at").limit(2000)).data ?? []) as Any[];
    const margins = new Map<string, { rate: number; at: number }>(
      marginRows.map((m) => [m.fut_token, { rate: Number(m.rate), at: Date.parse(m.fetched_at) }]),
    );

    // Closing view after the derivatives close (or on request).
    if (action === "close" || (phase === "closed" && minutes >= core.FO_CLOSE_MINUTES + 1 && sess.close_written_for !== today)) {
      await writeClose(db, jwt, today, contracts, settingsRaw, margins);
      await setStatus(db, { state: "idle", phase, message: "Closing-prices view saved", last_run_at: iso(started), last_ok_at: iso(Date.now()), last_duration_ms: Date.now() - started });
      return;
    }
    // End of continuous trading: summarise the last open-market snapshot before it is replaced.
    if (phase !== "open" && phase !== "pre_open" && minutes >= core.CASH_CONTINUOUS_END_MINUTES && sess.summary_written_for !== today) {
      await writeSessionSummary(db, today);
      await db.from("scanner_session").update({ summary_written_for: today }).eq("id", 1);
    }

    const config = { ...core.applySettings(settingsRaw), staleAfterMs: STALE_MS };
    const cycles = scheduled && phase === "open" ? 2 : 1;
    let fetchedCount = 0;
    for (let i = 0; i < cycles; i++) {
      if (i > 0) await sleep(started + i * POLL_MS - Date.now());
      const got = await getQuotes(db, today, jwt, contracts);
      jwt = got.jwt;
      const now = Date.now();
      const qm = quoteMap(got.fetched, now, "live");
      fetchedCount = got.fetched.length;
      const marketOpen = core.sessionPhase(now) === "open";
      const opps = contracts.map((c) =>
        core.computeOpportunity({
          contract: c, cashQuote: qm.get(`NSE:${c.cashToken}`), futQuote: qm.get(`NFO:${c.futToken}`), now, config, marketOpen,
          marginRate: margins.get(c.futToken)?.rate ?? null,
        }),
      );
      const ctx = { now, phase: core.sessionPhase(now), settingsRaw, fetchedAt: now, tokens: fetchedCount };
      const full = buildMessage("full", opps, qm, ctx);
      await check("snapshot", db.from("screener_snapshot").upsert({ id: 1, taken_at: iso(now), payload: full }));
      await broadcast("top", buildMessage("top", opps, qm, ctx)).catch(() => undefined);
      // Once a minute, tell dashboards to reload the full list (rows outside the top 100).
      if (i === 0) await broadcast("snapshot", { at: now, feed: full.feed, summary: full.summary }).catch(() => undefined);

      if (i === 0) {
        if (marketOpen) await sampleBasis(db, contracts, qm, now);
        if (phase === "open" || phase === "pre_open") await refreshMargins(db, jwt, contracts, qm, margins);
      }
      await setStatus(db, {
        state: marketOpen || core.sessionPhase(now) === "pre_open" ? "running" : "idle", phase: core.sessionPhase(now),
        message: marketOpen ? null : "Market not in continuous trading", last_run_at: iso(started), last_ok_at: iso(Date.now()),
        last_duration_ms: Date.now() - started, quotes_fetched: fetchedCount, contracts: contracts.length, margins_known: margins.size,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setStatus(db, { state: "error", last_error: msg, last_error_at: iso(Date.now()), last_run_at: iso(started) });
    throw e;
  } finally {
    await db.rpc("scanner_unlock");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = serviceClient();
  const who = await authorize(req, db);
  if (!who) return new Response("forbidden", { status: 403, headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action: Action = ["scan", "close", "relogin"].includes(body?.action) ? body.action : "scan";
  // Scheduled = the cron call (scan key, no explicit action). Phone or CLI requests are manual.
  const scheduled = who === "cron" && !body?.action && !body?.manual;
  EdgeRuntime.waitUntil(run(db, scheduled, action).catch((e) => console.error("scan failed:", e)));
  return Response.json({ accepted: true, action }, { status: 202, headers: CORS });
});
