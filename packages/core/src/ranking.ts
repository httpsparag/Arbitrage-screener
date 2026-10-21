import { basisNetProfit, type Opportunity } from './engine';

export type RankMetric =
  | 'yieldAfterCosts'
  | 'annualizedYield'
  | 'netProfitPerLot'
  | 'netReturnPct'
  | 'investmentProfit'
  | 'qualityScore';

export const RANK_METRICS: Record<RankMetric, string> = {
  yieldAfterCosts: 'Est. net yield after costs (p.a.)',
  annualizedYield: 'Est. excess yield over funding rate (p.a.)',
  netProfitPerLot: 'Est. net profit per lot',
  netReturnPct: 'Net return on cash capital',
  investmentProfit: 'Net profit for investment amount',
  qualityScore: 'Opportunity-quality score',
};

export const DEFAULT_RANK_METRIC: RankMetric = 'yieldAfterCosts';

export function metricValue(o: Opportunity, metric: RankMetric): number | null {
  const e = o.economics;
  const before = o.assumptions.profitBasis === 'before_funding';
  switch (metric) {
    case 'yieldAfterCosts':
      return e?.annualizedYieldBeforeFundingPct ?? null;
    case 'annualizedYield':
      return e?.annualizedYieldPct ?? null;
    case 'netProfitPerLot':
      return e ? basisNetProfit(e, o.assumptions.profitBasis) / e.lots : null;
    case 'netReturnPct':
      return e ? (before ? e.netReturnBeforeFundingPct : e.netReturnPct) : null;
    case 'investmentProfit':
      return o.investment?.netProfit ?? null;
    case 'qualityScore':
      return o.quality?.score ?? null;
  }
}

export type ExpirySelection = 'near' | 'next' | 'far' | 'all';
export type ResultView = 'executable' | 'research' | 'excluded' | 'all';

export interface Filters {
  view: ResultView;
  expiry: ExpirySelection;
  search: string;
  minNetProfitPerLot: number | null;
  minAnnualizedYieldPct: number | null;
  minNetReturnPct: number | null;
  /** Minimum turnover (rupees) on both legs. */
  minTurnover: number | null;
  /** Maximum bid–ask spread (% of mid) on either leg. */
  maxSpreadPct: number | null;
  /** Minimum visible depth as a multiple of the intended quantity. */
  minDepthCoverage: number | null;
  minDaysToExpiry: number | null;
  maxDaysToExpiry: number | null;
  watchlistOnly: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  view: 'executable',
  expiry: 'all',
  search: '',
  minNetProfitPerLot: null,
  minAnnualizedYieldPct: null,
  minNetReturnPct: null,
  minTurnover: null,
  maxSpreadPct: null,
  minDepthCoverage: null,
  minDaysToExpiry: null,
  maxDaysToExpiry: null,
  watchlistOnly: false,
};

/** 0 = nearest listed expiry for the symbol, 1 = next, 2 = far. */
export function expiryIndex(opps: readonly Opportunity[]): Map<string, number> {
  const bySymbol = new Map<string, string[]>();
  for (const o of opps) {
    const list = bySymbol.get(o.contract.symbol) ?? [];
    if (!list.includes(o.contract.expiry)) list.push(o.contract.expiry);
    bySymbol.set(o.contract.symbol, list);
  }
  for (const list of bySymbol.values()) list.sort();
  const out = new Map<string, number>();
  for (const o of opps) {
    out.set(o.key, bySymbol.get(o.contract.symbol)!.indexOf(o.contract.expiry));
  }
  return out;
}

function matchesView(o: Opportunity, view: ResultView): boolean {
  switch (view) {
    case 'executable':
      return o.status === 'executable';
    case 'research':
      return o.status === 'research' || o.status === 'unprofitable';
    case 'excluded':
      return o.status === 'excluded';
    case 'all':
      return true;
  }
}

const below = (v: number | null | undefined, min: number | null) =>
  min !== null && (v === null || v === undefined || v < min);

export function applyFilters(
  opps: readonly Opportunity[],
  f: Filters,
  watchlist: ReadonlySet<string> = new Set(),
): Opportunity[] {
  const idx = f.expiry === 'all' ? null : expiryIndex(opps);
  const wanted = { near: 0, next: 1, far: 2, all: -1 }[f.expiry];
  const q = f.search.trim().toUpperCase();
  return opps.filter((o) => {
    if (!matchesView(o, f.view)) return false;
    if (idx && idx.get(o.key) !== wanted) return false;
    if (q && !o.contract.symbol.includes(q) && !o.contract.name.toUpperCase().includes(q)) return false;
    if (f.watchlistOnly && !watchlist.has(o.contract.symbol)) return false;
    const e = o.economics;
    if (below(metricValue(o, 'netProfitPerLot'), f.minNetProfitPerLot)) return false;
    if (below(metricValue(o, 'yieldAfterCosts'), f.minAnnualizedYieldPct)) return false;
    if (below(metricValue(o, 'netReturnPct'), f.minNetReturnPct)) return false;
    if (f.minTurnover !== null) {
      const t = Math.min(o.quotes.cashTurnover ?? 0, o.quotes.futTurnover ?? 0);
      if (t < f.minTurnover) return false;
    }
    if (f.maxSpreadPct !== null) {
      const s = Math.max(o.quotes.cashSpreadPct ?? Infinity, o.quotes.futSpreadPct ?? Infinity);
      if (s > f.maxSpreadPct) return false;
    }
    if (f.minDepthCoverage !== null) {
      const qty = (e?.quantity ?? o.contract.lotSize * o.assumptions.lots) || 1;
      const cover = Math.min(o.quotes.cashAskDepthQty, o.quotes.futBidDepthQty) / qty;
      if (cover < f.minDepthCoverage) return false;
    }
    if (f.minDaysToExpiry !== null && o.daysToExpiry < f.minDaysToExpiry) return false;
    if (f.maxDaysToExpiry !== null && o.daysToExpiry > f.maxDaysToExpiry) return false;
    return true;
  });
}

export interface RankedOpportunity {
  rank: number;
  metric: RankMetric;
  value: number | null;
  opportunity: Opportunity;
}

/**
 * Sorts descending by the selected metric. Rows without a value go last.
 * Ties break on net profit per lot, then symbol and expiry, so the order is stable.
 */
export function rankOpportunities(
  opps: readonly Opportunity[],
  metric: RankMetric = DEFAULT_RANK_METRIC,
): RankedOpportunity[] {
  const rows = opps.map((o) => ({ o, v: metricValue(o, metric) }));
  rows.sort((a, b) => {
    if (a.v === null && b.v !== null) return 1;
    if (b.v === null && a.v !== null) return -1;
    if (a.v !== null && b.v !== null && a.v !== b.v) return b.v - a.v;
    const pa = metricValue(a.o, 'netProfitPerLot') ?? -Infinity;
    const pb = metricValue(b.o, 'netProfitPerLot') ?? -Infinity;
    if (pa !== pb) return pb - pa;
    return (
      a.o.contract.symbol.localeCompare(b.o.contract.symbol) ||
      a.o.contract.expiry.localeCompare(b.o.contract.expiry)
    );
  });
  return rows.map((r, i) => ({ rank: i + 1, metric, value: r.v, opportunity: r.o }));
}

export interface ScanSummary {
  stocks: number;
  contracts: number;
  executable: number;
  research: number;
  unprofitable: number;
  excluded: number;
  stale: number;
  /** Highest net yield after costs (p.a.) among executable rows. */
  bestAnnualizedYield: { value: number; key: string } | null;
  bestNetProfitPerLot: { value: number; key: string } | null;
  /** Executable rows whose quality score meets the threshold. */
  passingQuality: number;
  /** Executable rows that also beat the funding/opportunity rate. */
  beatingFundingRate: number;
}

export function summarize(opps: readonly Opportunity[], qualityThreshold = 60): ScanSummary {
  const s: ScanSummary = {
    stocks: new Set(opps.map((o) => o.contract.symbol)).size,
    contracts: opps.length,
    executable: 0,
    research: 0,
    unprofitable: 0,
    excluded: 0,
    stale: 0,
    bestAnnualizedYield: null,
    bestNetProfitPerLot: null,
    passingQuality: 0,
    beatingFundingRate: 0,
  };
  for (const o of opps) {
    s[o.status]++;
    if (o.exclusionReasons.some((r) => r === 'STALE_CASH_QUOTE' || r === 'STALE_FUT_QUOTE')) s.stale++;
    if (o.status !== 'executable' || !o.economics) continue;
    const y = metricValue(o, 'yieldAfterCosts');
    if (y !== null && (!s.bestAnnualizedYield || y > s.bestAnnualizedYield.value)) {
      s.bestAnnualizedYield = { value: y, key: o.key };
    }
    if (o.economics.beatsFundingRate) s.beatingFundingRate++;
    const p = metricValue(o, 'netProfitPerLot')!;
    if (!s.bestNetProfitPerLot || p > s.bestNetProfitPerLot.value) {
      s.bestNetProfitPerLot = { value: p, key: o.key };
    }
    if ((o.quality?.score ?? 0) >= qualityThreshold) s.passingQuality++;
  }
  return s;
}
