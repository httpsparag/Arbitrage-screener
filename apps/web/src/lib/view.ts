import { sessionPhase, type ExclusionReason, type SessionPhase, type WarningCode, type WireFeed, type WireRow } from "@arb/core";
import { ago } from "./format";
import type { ChannelState, RowState } from "./useScreener";

// ───────────── Feed status (never shows LIVE unless data is genuinely fresh) ─────────────

export type Tone = "live" | "warn" | "down" | "idle";

export interface LiveStatus {
  label: string;
  tone: Tone;
  detail: string;
  phase: SessionPhase;
}

const PHASE_LABEL: Record<SessionPhase, string> = {
  pre_open: "PRE-OPEN",
  open: "OPEN",
  closing_auction: "CLOSING AUCTION",
  fo_only: "MARKET CLOSED",
  closed: "MARKET CLOSED",
};

/** Fresh = a worker message within this window during the session. */
export const LIVE_WINDOW_MS = 15_000;
export const OFFLINE_AFTER_MS = 60_000;
/** A row not refreshed for this long during the session is treated as stale. */
export const ROW_STALE_MS = 90_000;

export function liveStatus(
  now: number,
  lastMessageAt: number | null,
  feed: WireFeed | null,
  channel: ChannelState,
): LiveStatus {
  const phase = sessionPhase(now);
  if (!lastMessageAt) return { label: "NO DATA", tone: "idle", detail: "Waiting for the worker…", phase };
  const age = now - lastMessageAt;
  if (phase !== "open") {
    return { label: PHASE_LABEL[phase], tone: "idle", detail: `Last update ${ago(age)} · not executable`, phase };
  }
  if (age > OFFLINE_AFTER_MS) {
    return { label: "OFFLINE", tone: "down", detail: `No data for ${ago(age).replace(" ago", "")} — is the worker running?`, phase };
  }
  if (channel === "error") return { label: "RECONNECTING", tone: "warn", detail: `Last update ${ago(age)}`, phase };
  if (feed && feed.state !== "connected") {
    return { label: "FEED " + feed.state.toUpperCase(), tone: "warn", detail: feed.lastError ?? `Last update ${ago(age)}`, phase };
  }
  if (age > LIVE_WINDOW_MS) return { label: "STALE", tone: "warn", detail: `Last update ${ago(age)}`, phase };
  return { label: "LIVE", tone: "live", detail: `Updated ${ago(age)}`, phase };
}

export function rowIsStale(s: RowState, now: number, phase: SessionPhase): boolean {
  return phase === "open" && now - s.at > ROW_STALE_MS;
}

// ───────────── Filters and sorting over wire rows ─────────────

export type View = "profitable" | "beats" | "research" | "excluded" | "all";
export type ExpiryPick = "all" | "near" | "next" | "far";
export type SortKey = "yield" | "excess" | "netLot" | "netReturn" | "gross" | "quality" | "days" | "capital" | "capYield";

export interface Filters {
  view: View;
  expiry: ExpiryPick;
  search: string;
  watchOnly: boolean;
  minYield: number | null;
  /** Maximum capital required per position, rupees. */
  maxCapital: number | null;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = {
  view: "profitable",
  expiry: "all",
  search: "",
  watchOnly: false,
  minYield: null,
  maxCapital: null,
  sort: "yield",
};

export const SORT_LABEL: Record<SortKey, string> = {
  yield: "Net yield after costs",
  excess: "Excess over funding rate",
  netLot: "Net profit per lot",
  netReturn: "Net return %",
  gross: "Gross spread %",
  quality: "Quality score",
  days: "Days to expiry",
  capital: "Lowest capital required",
  capYield: "Yield on total capital",
};

const sortValue = (r: WireRow, k: SortKey): number | null => {
  switch (k) {
    case "yield": return r.m[0];
    case "excess": return r.m[1];
    case "netLot": return r.m[2];
    case "netReturn": return r.m[3];
    case "gross": return r.m[5];
    case "quality": return r.m[9];
    case "days": return -r.d; // nearest first
    case "capital": return r.m[10] == null ? null : -r.m[10]; // smallest first
    case "capYield": return r.m[11] ?? null;
  }
};

/**
 * 'live': rows from the running session, filtered by executable status.
 * 'close': rows calculated from closing prices (all theoretical), filtered by their net figures.
 */
export type DataMode = "live" | "close";

export function selectRows(
  all: RowState[],
  f: Filters,
  watchlist: ReadonlySet<string>,
  now: number,
  mode: DataMode = "live",
): RowState[] {
  const phase = sessionPhase(now);
  const expiries = new Map<string, string[]>();
  for (const s of all) {
    const list = expiries.get(s.row.s) ?? [];
    if (!list.includes(s.row.e)) list.push(s.row.e);
    expiries.set(s.row.s, list);
  }
  for (const l of expiries.values()) l.sort();
  const wantIdx = { all: -1, near: 0, next: 1, far: 2 }[f.expiry];
  const q = f.search.trim().toUpperCase();

  const out = all.filter((s) => {
    const r = s.row;
    const stale = mode === "live" && rowIsStale(s, now, phase);
    if (mode === "close") {
      const y = r.m[0];
      switch (f.view) {
        case "profitable": if (r.st === "excluded" || !(y !== null && y > 0)) return false; break;
        case "beats": if (r.st === "excluded" || !(r.m[1] !== null && r.m[1] > 0)) return false; break;
        case "research": if (r.st === "excluded" || !(y !== null && y <= 0)) return false; break;
        case "excluded": if (r.st !== "excluded") return false; break;
        case "all": break;
      }
    } else switch (f.view) {
      case "profitable": if (r.st !== "executable" || stale) return false; break;
      case "beats": if (r.st !== "executable" || stale || !(r.m[1] !== null && r.m[1] > 0)) return false; break;
      case "research": if ((r.st !== "research" && r.st !== "unprofitable") || stale) return false; break;
      case "excluded": if (r.st !== "excluded" && !stale) return false; break;
      case "all": break;
    }
    if (wantIdx >= 0 && expiries.get(r.s)!.indexOf(r.e) !== wantIdx) return false;
    if (q && !r.s.includes(q)) return false;
    if (f.watchOnly && !watchlist.has(r.s)) return false;
    if (f.minYield !== null && !(r.m[0] !== null && r.m[0] >= f.minYield)) return false;
    if (f.maxCapital !== null && !(r.m[10] != null && r.m[10] <= f.maxCapital)) return false;
    return true;
  });
  out.sort((a, b) => {
    const va = sortValue(a.row, f.sort);
    const vb = sortValue(b.row, f.sort);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return a.row.s.localeCompare(b.row.s) || a.row.e.localeCompare(b.row.e);
  });
  return out;
}

// ───────────── Human-readable labels ─────────────

export const REASON_LABEL: Record<ExclusionReason, string> = {
  MARKET_CLOSED: "Market closed (cash leg not in continuous trading)",
  CROSSED_BOOK: "Order book crossed (auction or bad data)",
  MISSING_CASH_QUOTE: "No cash quote",
  MISSING_FUT_QUOTE: "No futures quote",
  STALE_CASH_QUOTE: "Cash quote is stale",
  STALE_FUT_QUOTE: "Futures quote is stale",
  CASH_NOT_TRADABLE: "Cash leg not tradable",
  FUT_NOT_TRADABLE: "Futures leg not tradable",
  CONTRACT_EXPIRED: "Contract expired",
  CONTRACT_SUSPENDED: "Contract suspended",
  CONTRACT_IN_BAN_PERIOD: "Security in F&O ban period",
  TOKEN_MISMATCH: "Instrument mismatch",
  INVALID_LOT_SIZE: "Invalid lot size",
  NO_CASH_ASK: "No cash ask (sellers)",
  NO_FUT_BID: "No futures bid (buyers)",
  NO_CASH_LTP: "No cash last price",
  NO_FUT_LTP: "No futures last price",
  INVALID_PRICE: "Implausible futures/cash price ratio",
  INSUFFICIENT_CASH_DEPTH: "Not enough cash depth for the quantity",
  INSUFFICIENT_FUT_DEPTH: "Not enough futures depth for the quantity",
};

export const WARNING_LABEL: Partial<Record<WarningCode, string>> = {
  NEAR_EXPIRY: "Near expiry",
  EXPIRY_DAY: "Expires today",
  TOP_OF_BOOK_QTY_LOW: "Thin top of book",
  DIVIDEND_IN_WINDOW: "Dividend before expiry",
  DIVIDEND_UNCERTAIN: "Dividend uncertain",
  DIVIDEND_FUTURES_ADJUSTED: "Dividend adjusted in futures",
  CORPORATE_ACTION_IN_WINDOW: "Corporate action before expiry",
  NON_LIVE_DATA: "Not live data",
  SAMPLE_DATA: "SAMPLE DATA",
  THEORETICAL_LTP_MODE: "Theoretical (LTP)",
  WIDE_SPREAD: "Wide spread",
};

export const STATUS_LABEL: Record<WireRow["st"], string> = {
  executable: "Profitable",
  unprofitable: "Unprofitable",
  research: "Research",
  excluded: "Excluded",
};
