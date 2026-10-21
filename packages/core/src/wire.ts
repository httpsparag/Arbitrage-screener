// Compact row format sent from the worker to the dashboard (Supabase Realtime broadcast).
// Kept small to fit free-tier egress; carries enough inputs for the dashboard to
// recompute the full calculation breakdown with the same engine.

import { metricValue } from './ranking';
import type { Opportunity } from './engine';
import type {
  Contract,
  DataKind,
  ExclusionReason,
  OpportunityStatus,
  Quote,
  WarningCode,
} from './types';

/** [ltp, bid, bidQty, ask, askQty, turnover, oi, ageMs, askDepthQty | bidDepthQty] */
export type WireQuote = [
  ltp: number | null,
  bid: number | null,
  bidQty: number | null,
  ask: number | null,
  askQty: number | null,
  turnover: number | null,
  oi: number | null,
  ageMs: number | null,
  depthQty: number,
];

/**
 * [yieldAfterCosts, excessYield, netPerLot, netReturnPct, grossSpread, grossPct, grossPerLot, costs, funding, quality,
 *  capitalRequired, yieldOnCapital]. The last two are absent in snapshots written before they existed.
 */
export type WireMetrics = [
  yieldAfterCosts: number | null,
  excessYield: number | null,
  netPerLot: number | null,
  netReturnPct: number | null,
  grossSpread: number | null,
  grossSpreadPct: number | null,
  grossPerLot: number | null,
  costs: number | null,
  funding: number | null,
  quality: number | null,
  capitalRequired?: number | null,
  yieldOnCapital?: number | null,
];

export interface WireRow {
  /** Futures token (row key). */
  k: string;
  /** Cash token. */
  ck: string;
  s: string;
  e: string;
  l: number;
  ts: number;
  d: number;
  st: OpportunityStatus;
  dk: DataKind | null;
  x: ExclusionReason[];
  w: WarningCode[];
  c: WireQuote;
  f: WireQuote;
  m: WireMetrics;
  /** Exchange trading symbol of the future, e.g. RELIANCE27OCT26FUT. */
  fs: string;
  /** Broker margin rate for the short future (fraction of futures value), when known. */
  mr?: number | null;
}

const r = (v: number | null | undefined, dp: number): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

export function toWireRow(o: Opportunity): WireRow {
  const q = o.quotes;
  const e = o.economics;
  return {
    k: o.contract.futToken,
    ck: o.contract.cashToken,
    s: o.contract.symbol,
    e: o.contract.expiry,
    l: o.contract.lotSize,
    ts: o.contract.tickSize,
    d: o.daysToExpiry,
    st: o.status,
    dk: o.dataKind,
    x: o.exclusionReasons,
    w: o.warnings.map((w) => w.code).filter((c) => c !== 'EXIT_PRICE_ESTIMATED' && c !== 'BROKERAGE_ESTIMATED'),
    c: [r(q.cashLtp, 2), r(q.cashBid, 2), null, r(q.cashAsk, 2), null, r(q.cashTurnover, 0), null, q.cashAgeMs, q.cashAskDepthQty],
    f: [r(q.futLtp, 2), r(q.futBid, 2), null, r(q.futAsk, 2), null, r(q.futTurnover, 0), q.openInterest, q.futAgeMs, q.futBidDepthQty],
    m: [
      r(metricValue(o, 'yieldAfterCosts'), 3),
      r(metricValue(o, 'annualizedYield'), 3),
      r(metricValue(o, 'netProfitPerLot'), 2),
      r(metricValue(o, 'netReturnPct'), 4),
      r(e?.grossSpread, 2),
      r(e?.grossSpreadPct, 4),
      r(e?.grossSpreadValuePerLot, 2),
      r(e?.costs.total, 2),
      r(e?.fundingCost, 2),
      r(o.quality?.score, 1),
      r(e?.capitalRequired, 0),
      r(e?.annualizedYieldOnCapitalPct, 3),
    ],
    fs: o.contract.futTradingSymbol,
    mr: e?.marginSource === 'broker' ? r(e.marginRateUsed, 5) : null,
  };
}

/** Adds best-level quantities, which the engine needs to judge top-of-book adequacy. */
export function withTopQuantities(row: WireRow, cash: Quote | undefined, fut: Quote | undefined): WireRow {
  row.c[2] = cash?.bids[0]?.quantity ?? null;
  row.c[4] = cash?.asks[0]?.quantity ?? null;
  row.f[2] = fut?.bids[0]?.quantity ?? null;
  row.f[4] = fut?.asks[0]?.quantity ?? null;
  return row;
}

/**
 * Rebuilds engine inputs from a wire row so the dashboard can recompute the full breakdown.
 * Only the best level is available, so depth mode is not reproducible from a wire row.
 */
export function fromWireRow(
  row: WireRow,
  receivedAt: number,
  dataKind: DataKind = row.dk ?? 'live',
): { contract: Contract; cashQuote: Quote; futQuote: Quote; marginRate: number | null } {
  const quote = (token: string, w: WireQuote): Quote => ({
    token,
    ltp: w[0],
    bids: w[1] !== null ? [{ price: w[1], quantity: w[2] ?? 0 }] : [],
    asks: w[3] !== null ? [{ price: w[3], quantity: w[4] ?? 0 }] : [],
    volume: null,
    turnover: w[5],
    openInterest: w[6],
    exchangeTimestamp: null,
    receivedAt: receivedAt - (w[7] ?? 0),
    tradable: !row.x.includes('CASH_NOT_TRADABLE') && !row.x.includes('FUT_NOT_TRADABLE'),
    dataKind,
  });
  return {
    contract: {
      symbol: row.s,
      name: row.s,
      cashToken: row.ck,
      cashTradingSymbol: `${row.s}-EQ`,
      futToken: row.k,
      futTradingSymbol: row.fs,
      expiry: row.e,
      lotSize: row.l,
      tickSize: row.ts,
      status: 'active',
    },
    cashQuote: quote(row.ck, row.c),
    futQuote: quote(row.k, row.f),
    marginRate: row.mr ?? null,
  };
}

export interface WireFeed {
  provider: string;
  dataKind: DataKind;
  state: string;
  lastTickAt: number | null;
  lastMessageAt: number | null;
  subscribed: number;
  reconnects: number;
  lastError: string | null;
  /** 'open' | 'pre_open' | 'closed' by the exchange clock. */
  session: string;
}

export interface WireSummary {
  stocks: number;
  contracts: number;
  executable: number;
  beatingFundingRate: number;
  unprofitable: number;
  research: number;
  excluded: number;
  stale: number;
  passingQuality: number;
  bestYieldAfterCosts: number | null;
  bestNetProfitPerLot: number | null;
}

export interface WireMessage {
  /**
   * 'top': best rows every few seconds; 'full': entire universe;
   * 'close': entire universe calculated from the session's closing prices (theoretical).
   */
  kind: 'top' | 'full' | 'close';
  /** For 'close': the trading date the closing prices belong to (YYYY-MM-DD). */
  tradeDate?: string;
  at: number;
  version: string;
  feed: WireFeed;
  summary: WireSummary;
  settings: Record<string, unknown>;
  rows: WireRow[];
}
