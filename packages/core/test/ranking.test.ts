import { describe, expect, it } from 'vitest';
import { computeOpportunity } from '../src/engine';
import { applyFilters, DEFAULT_FILTERS, metricValue, rankOpportunities, summarize } from '../src/ranking';
import { NOW, config, contract, quote } from './fixtures';

function opp(symbol: string, expiry: string, futBid: number, over: { stale?: boolean } = {}) {
  const c = contract({ symbol, name: `${symbol} Ltd`, cashToken: `C-${symbol}`, futToken: `F-${symbol}-${expiry}`, expiry });
  return computeOpportunity({
    contract: c,
    cashQuote: quote(c.cashToken, { bid: 999.9, ask: 1000, receivedAt: over.stale ? NOW - 60_000 : NOW - 1000 }),
    futQuote: quote(c.futToken, { bid: futBid, ask: futBid + 0.2 }),
    now: NOW,
    config: config(),
  });
}

const opps = [
  opp('AAA', '2026-11-19', 1010), // 30 days, net ≈ ₹605, ≈1.5% p.a.
  opp('BBB', '2026-11-19', 1012), // 30 days, net ≈ ₹1,600
  opp('CCC', '2026-10-27', 1006), // 7 days: small spread, highest annualized (≈8.5% p.a.)
  opp('AAA', '2026-12-17', 1018), // next expiry for AAA: largest gross spread, ≈2.4% p.a.
  opp('DDD', '2026-11-19', 1001), // unprofitable
  opp('EEE', '2026-11-19', 1012, { stale: true }), // excluded
];

describe('ranking', () => {
  it('sorts descending by the selected metric', () => {
    for (const metric of ['yieldAfterCosts', 'annualizedYield', 'netProfitPerLot', 'netReturnPct', 'qualityScore'] as const) {
      const ranked = rankOpportunities(opps, metric);
      const values = ranked.map((r) => r.value).filter((v): v is number => v !== null);
      expect(values).toEqual([...values].sort((a, b) => b - a));
      expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(ranked.at(-1)!.value).toBeNull(); // excluded row has no value and goes last
    }
  });

  it('annualized yield can rank a short contract above a larger gross premium', () => {
    const exec = applyFilters(opps, DEFAULT_FILTERS);
    const top = rankOpportunities(exec, 'annualizedYield')[0]!.opportunity;
    const byGross = [...exec].sort((a, b) => b.economics!.grossSpread - a.economics!.grossSpread)[0]!;
    expect(top.economics!.annualizedYieldPct).toBeGreaterThan(byGross.economics!.annualizedYieldPct!);
  });
});

describe('filters', () => {
  it('default view shows only executable (positive net, valid, fresh) rows', () => {
    const rows = applyFilters(opps, DEFAULT_FILTERS);
    expect(rows.every((o) => o.status === 'executable')).toBe(true);
    expect(rows.map((o) => o.contract.symbol)).not.toContain('DDD');
    expect(rows.map((o) => o.contract.symbol)).not.toContain('EEE');
  });

  it('research and excluded views', () => {
    expect(applyFilters(opps, { ...DEFAULT_FILTERS, view: 'research' }).map((o) => o.contract.symbol)).toEqual(['DDD']);
    expect(applyFilters(opps, { ...DEFAULT_FILTERS, view: 'excluded' }).map((o) => o.contract.symbol)).toEqual(['EEE']);
  });

  it('expiry selection is per symbol', () => {
    const near = applyFilters(opps, { ...DEFAULT_FILTERS, view: 'all', expiry: 'near' });
    expect(near.filter((o) => o.contract.symbol === 'AAA').map((o) => o.contract.expiry)).toEqual(['2026-11-19']);
    const next = applyFilters(opps, { ...DEFAULT_FILTERS, view: 'all', expiry: 'next' });
    expect(next.map((o) => o.contract.symbol)).toEqual(['AAA']);
  });

  it('threshold, search, days and watchlist filters', () => {
    const all = { ...DEFAULT_FILTERS, view: 'all' as const };
    expect(applyFilters(opps, { ...all, search: 'bbb' }).map((o) => o.contract.symbol)).toEqual(['BBB']);
    expect(applyFilters(opps, { ...all, maxDaysToExpiry: 10 }).map((o) => o.contract.symbol)).toEqual(['CCC']);
    expect(applyFilters(opps, { ...all, watchlistOnly: true }, new Set(['DDD'])).map((o) => o.contract.symbol)).toEqual(['DDD']);
    const minProfit = applyFilters(opps, { ...all, minNetProfitPerLot: 1000 });
    expect(minProfit.length).toBeGreaterThan(0);
    expect(minProfit.every((o) => metricValue(o, 'netProfitPerLot')! >= 1000)).toBe(true);
  });
});

describe('summary', () => {
  it('counts statuses and best values from executable rows only', () => {
    const s = summarize(opps);
    expect(s.stocks).toBe(5);
    expect(s.contracts).toBe(6);
    expect(s.excluded).toBe(1);
    expect(s.stale).toBe(1);
    expect(s.unprofitable).toBe(1);
    expect(s.executable).toBe(4);
    expect(s.bestNetProfitPerLot!.key).toBe('F-AAA-2026-12-17');
  });
});
