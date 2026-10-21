import { describe, expect, it } from 'vitest';
import { computeEconomics, computeOpportunity } from '../src/engine';
import { scheduleFor } from '../src/costs/schedules';
import { fillFromDepth } from '../src/pricing';
import { daysBetween, isExpired } from '../src/dates';
import { NOW, config, contract, pair, quote } from './fixtures';

const run = (over: Parameters<typeof config>[0] = {}, extra: Partial<Parameters<typeof computeOpportunity>[0]> = {}) =>
  computeOpportunity({ contract: contract(), ...pair(), now: NOW, config: config(over), ...extra });

describe('hand-worked example: 1 lot of 500, cash ask 1000, futures bid 1010, 30 days, square-off', () => {
  const o = run();
  const e = o.economics!;

  it('is executable', () => {
    expect(o.status).toBe('executable');
    expect(o.exclusionReasons).toEqual([]);
  });

  it('gross spread', () => {
    expect(e.cashBuyPrice).toBe(1000);
    expect(e.futSellPrice).toBe(1010);
    expect(e.grossSpread).toBe(10);
    expect(e.grossSpreadPct).toBeCloseTo(1.0, 10);
    expect(e.grossSpreadValuePerLot).toBe(5000);
    expect(e.cashValue).toBe(500_000);
    expect(e.futValue).toBe(505_000);
  });

  it('transaction costs per leg and phase', () => {
    // Entry cash buy ₹5,00,000: brokerage 20, STT 500, exch 15.35, SEBI 0.5, IPFT 0.5, stamp 75,
    //   GST 18% × 36.35 = 6.543  → 617.893
    // Entry futures sell ₹5,05,000: brokerage 20, STT 252.5, exch 9.2415, SEBI 0.505, IPFT 0.505,
    //   GST 18% × 30.2515 = 5.44527 → 288.19677
    // Exit cash sell ₹5,00,000: brokerage 20, STT 500, exch 15.35, SEBI 0.5, IPFT 0.5, DP 20,
    //   GST 18% × 56.35 = 10.143 → 566.493
    // Exit futures buy ₹5,00,000: brokerage 20, exch 9.15, SEBI 0.5, IPFT 0.5, stamp 10,
    //   GST 18% × 30.15 = 5.427 → 45.577
    expect(e.costs.byLeg.cash).toBeCloseTo(617.893 + 566.493, 6);
    expect(e.costs.byLeg.futures).toBeCloseTo(288.19677 + 45.577, 6);
    expect(e.costs.byPhase.entry).toBeCloseTo(617.893 + 288.19677, 6);
    expect(e.costs.total).toBeCloseTo(1518.15977, 6);
    expect(e.costs.byComponent.stt).toBeCloseTo(1252.5, 6);
    expect(e.costs.byComponent.stamp).toBeCloseTo(85, 6);
    expect(e.costs.scheduleId).toBe('nse-2026-04');
  });

  it('funding, net profit, return and annualized yield', () => {
    expect(e.holdingDays).toBe(30);
    expect(e.fundingCost).toBeCloseTo((500_000 * 0.07 * 30) / 365, 6); // 2876.7123
    expect(e.netProfit).toBeCloseTo(5000 - 1518.15977 - 2876.712329, 4); // 605.1279
    expect(e.netProfitPerLot).toBeCloseTo(e.netProfit, 10);
    expect(e.netReturnPct).toBeCloseTo((605.127901 / 500_000) * 100, 5);
    expect(e.annualizedYieldPct!).toBeCloseTo((605.127901 / 500_000) * (365 / 30) * 100, 4); // ≈1.4725
  });

  it('before-funding figures: return on own capital after costs', () => {
    expect(e.netProfitBeforeFunding).toBeCloseTo(5000 - 1518.15977, 5); // 3481.84
    expect(e.netReturnBeforeFundingPct).toBeCloseTo((3481.84023 / 500_000) * 100, 6);
    expect(e.annualizedYieldBeforeFundingPct!).toBeCloseTo((3481.84023 / 500_000) * (365 / 30) * 100, 4); // ≈8.47
    // Excess over funding = yield after costs − funding rate (same day-count basis).
    expect(e.annualizedYieldPct!).toBeCloseTo(e.annualizedYieldBeforeFundingPct! - 7, 10);
    expect(e.beatsFundingRate).toBe(true);
  });

  it('profit basis decides status', () => {
    // Cash 1000 / futures 1007, 30 days: positive after costs, negative after 7% funding.
    const args = {
      contract: contract(),
      cashQuote: quote('C1', { bid: 999.9, ask: 1000 }),
      futQuote: quote('F1', { bid: 1007, ask: 1007.2 }),
      now: NOW,
    };
    const before = computeOpportunity({ ...args, config: config() });
    expect(before.economics!.netProfitBeforeFunding).toBeGreaterThan(0);
    expect(before.economics!.beatsFundingRate).toBe(false);
    expect(before.status).toBe('executable');
    expect(computeOpportunity({ ...args, config: config({ profitBasis: 'after_funding' }) }).status).toBe('unprofitable');
  });

  it('capital measures are kept separate', () => {
    expect(e.marginEstimate).toBeCloseTo(505_000 * 0.2, 6);
    expect(e.totalCapitalAllocated).toBeCloseTo(500_000 + 101_000, 6);
    expect(e.netReturnOnAllocatedPct).toBeCloseTo((e.netProfit / 601_000) * 100, 8);
  });

  it('LTP basis is reported separately and only informationally', () => {
    expect(o.ltpGrossSpread).toBeCloseTo(10.1, 10);
  });
});

describe('exit modes and assumptions', () => {
  it('physical settlement replaces the exit orders with a delivery-rate settlement', () => {
    const e = run({ exitMode: 'physical_settlement' }).economics!;
    // Exit: brokerage 20, STT 500, exch 15.35, SEBI 0.5, IPFT 0.5, DP 20, GST 10.143 → 566.493
    expect(e.costs.total).toBeCloseTo(617.893 + 288.19677 + 566.493, 6);
    expect(e.costs.items.some((i) => i.leg === 'futures' && i.phase === 'exit')).toBe(false);
  });

  it('exit slippage adds a cost on each leg', () => {
    const base = run().economics!.costs.total;
    const e = run({ exitSlippageBps: 5 }).economics!;
    expect(e.costs.byComponent.slippage).toBeCloseTo(2 * 500_000 * 0.0005, 6);
    expect(e.costs.total).toBeCloseTo(base + 500, 6);
  });

  it('borrowed capital blends the funding rate', () => {
    const e = run({
      funding: { ownCapitalRate: 0.07, borrowedFraction: 0.5, borrowRate: 0.12, dayCountBasis: 365 },
    }).economics!;
    expect(e.fundingRateBlended).toBeCloseTo(0.095, 12);
    expect(e.fundingCost).toBeCloseTo((500_000 * 0.095 * 30) / 365, 6);
  });

  it('pledged shares reduce extra margin cash, capped by the 50:50 rule', () => {
    const e = run({
      margin: { marginRate: 0.2, pledgeShares: true, pledgeHaircut: 0.2, maxCollateralShareOfMargin: 0.5 },
    }).economics!;
    expect(e.collateralCredit).toBeCloseTo(50_500, 6);
    expect(e.totalCapitalAllocated).toBeCloseTo(500_000 + 101_000 - 50_500, 6);
  });

  it('a negative net result is unprofitable, not executable', () => {
    const o = computeOpportunity({
      contract: contract(),
      cashQuote: quote('C1', { bid: 999.9, ask: 1000 }),
      futQuote: quote('F1', { bid: 1002, ask: 1002.2 }),
      now: NOW,
      config: config(),
    });
    expect(o.economics!.netProfit).toBeLessThan(0);
    expect(o.status).toBe('unprofitable');
  });

  it('investment amount uses whole lots and exact economics', () => {
    const o = run({ investmentAmount: 1_200_000 });
    expect(o.investment!.lots).toBe(2);
    const exact = computeEconomics({
      contract: contract(),
      cashBuyPrice: 1000,
      futSellPrice: 1010,
      lots: 2,
      today: '2026-10-20',
      config: config(),
    }).economics.netProfitBeforeFunding;
    expect(o.investment!.netProfit).toBeCloseTo(exact, 10);
  });
});

describe('validation gate', () => {
  it('missing quotes', () => {
    const o = computeOpportunity({ contract: contract(), cashQuote: null, futQuote: pair().futQuote, now: NOW, config: config() });
    expect(o.status).toBe('excluded');
    expect(o.exclusionReasons).toContain('MISSING_CASH_QUOTE');
    expect(o.economics).toBeNull();
  });

  it('stale quotes are excluded', () => {
    const { cashQuote, futQuote } = pair();
    const o = computeOpportunity({
      contract: contract(),
      cashQuote: { ...cashQuote, receivedAt: NOW - 60_000 },
      futQuote,
      now: NOW,
      config: config(),
    });
    expect(o.status).toBe('excluded');
    expect(o.exclusionReasons).toEqual(['STALE_CASH_QUOTE']);
    expect(o.quotes.cashAgeMs).toBe(60_000);
  });

  it('zero or missing executable prices', () => {
    const o = computeOpportunity({
      contract: contract(),
      cashQuote: quote('C1', { bid: 999, ask: 0 }),
      futQuote: quote('F1', { ask: 1010.2 }),
      now: NOW,
      config: config(),
    });
    expect(o.exclusionReasons).toEqual(expect.arrayContaining(['NO_CASH_ASK', 'NO_FUT_BID']));
  });

  it('mismatched instrument tokens', () => {
    const o = computeOpportunity({ contract: contract({ cashToken: 'OTHER' }), ...pair(), now: NOW, config: config() });
    expect(o.exclusionReasons).toContain('TOKEN_MISMATCH');
  });

  it('implausible futures/cash ratio is treated as a data error', () => {
    const o = computeOpportunity({
      contract: contract(),
      cashQuote: quote('C1', { bid: 999.9, ask: 1000 }),
      futQuote: quote('F1', { bid: 2000, ask: 2000.5 }),
      now: NOW,
      config: config(),
    });
    expect(o.exclusionReasons).toContain('INVALID_PRICE');
  });

  it('expired, suspended, banned and not-tradable contracts', () => {
    expect(run({}, { contract: contract({ expiry: '2026-10-19' }) }).exclusionReasons).toContain('CONTRACT_EXPIRED');
    expect(run({}, { contract: contract({ status: 'ban_period' }) }).exclusionReasons).toContain('CONTRACT_IN_BAN_PERIOD');
    const { cashQuote, futQuote } = pair();
    expect(run({}, { futQuote: { ...futQuote, tradable: false }, cashQuote }).exclusionReasons).toContain('FUT_NOT_TRADABLE');
  });

  it('expiry day: valid before the close, no annualized yield', () => {
    const o = run({}, { contract: contract({ expiry: '2026-10-20' }) });
    expect(o.economics!.holdingDays).toBe(0);
    expect(o.economics!.annualizedYieldPct).toBeNull();
    expect(o.warnings.map((w) => w.code)).toContain('EXPIRY_DAY');
    const afterClose = Date.parse('2026-10-20T10:10:00Z'); // 15:40 IST, derivatives close
    expect(isExpired('2026-10-20', afterClose)).toBe(true);
    expect(isExpired('2026-10-20', NOW)).toBe(false);
    expect(isExpired('2026-10-20', Date.parse('2026-10-20T10:05:00Z'))).toBe(false); // 15:35: futures still trade
  });

  it('crossed books (auction or bad data) are excluded', () => {
    const o = computeOpportunity({
      contract: contract(),
      cashQuote: quote('C1', { bid: 1016.45, ask: 998.05 }),
      futQuote: quote('F1', { bid: 1010, ask: 1010.2 }),
      now: NOW,
      config: config(),
    });
    expect(o.status).toBe('excluded');
    expect(o.exclusionReasons).toContain('CROSSED_BOOK');
  });

  it('market closed flag', () => {
    expect(run({}, { marketOpen: false }).exclusionReasons).toContain('MARKET_CLOSED');
  });

  it('invalid lot size', () => {
    expect(run({}, { contract: contract({ lotSize: 0 }) }).exclusionReasons).toContain('INVALID_LOT_SIZE');
  });
});

describe('price modes and data kinds', () => {
  it('LTP mode is research only, never executable', () => {
    const o = run({ priceMode: 'ltp' });
    expect(o.status).toBe('research');
    expect(o.economics!.cashBuyPrice).toBe(1000);
    expect(o.economics!.futSellPrice).toBe(1010.1);
    expect(o.warnings.map((w) => w.code)).toContain('THEORETICAL_LTP_MODE');
  });

  it('delayed data is research only', () => {
    const { cashQuote, futQuote } = pair();
    const o = run({}, { cashQuote: { ...cashQuote, dataKind: 'delayed' }, futQuote });
    expect(o.status).toBe('research');
    expect(o.dataKind).toBe('delayed');
  });

  it('sample data is labelled', () => {
    const { cashQuote, futQuote } = pair();
    const o = run({}, { cashQuote: { ...cashQuote, dataKind: 'sample' }, futQuote: { ...futQuote, dataKind: 'sample' } });
    expect(o.dataKind).toBe('sample');
    expect(o.warnings.map((w) => w.code)).toContain('SAMPLE_DATA');
  });

  it('depth mode walks the book', () => {
    const cashQuote = quote('C1', { bid: 999.9 });
    cashQuote.asks = [
      { price: 1000, quantity: 200 },
      { price: 1000.5, quantity: 300 },
    ];
    const futQuote = quote('F1', { ask: 1010.2 });
    futQuote.bids = [
      { price: 1010, quantity: 100 },
      { price: 1009.5, quantity: 1000 },
    ];
    const o = computeOpportunity({ contract: contract(), cashQuote, futQuote, now: NOW, config: config({ priceMode: 'depth' }) });
    expect(o.economics!.cashBuyPrice).toBeCloseTo((200 * 1000 + 300 * 1000.5) / 500, 10);
    expect(o.economics!.futSellPrice).toBeCloseTo((100 * 1010 + 400 * 1009.5) / 500, 10);
  });

  it('depth mode excludes when visible depth cannot fill a lot', () => {
    const cashQuote = quote('C1', { bid: 999.9 });
    cashQuote.asks = [{ price: 1000, quantity: 100 }];
    const o = computeOpportunity({ contract: contract(), cashQuote, futQuote: pair().futQuote, now: NOW, config: config({ priceMode: 'depth' }) });
    expect(o.exclusionReasons).toContain('INSUFFICIENT_CASH_DEPTH');
  });

  it('bid/ask mode warns when top-of-book quantity is below the lot', () => {
    const { cashQuote, futQuote } = pair();
    cashQuote.asks = [{ price: 1000, quantity: 10 }];
    expect(run({}, { cashQuote, futQuote }).warnings.map((w) => w.code)).toContain('TOP_OF_BOOK_QTY_LOW');
  });
});

describe('dividends', () => {
  const base = run().economics!.netProfit;
  const div = (over: object) =>
    run({}, {
      corporateActions: [
        { symbol: 'XYZ', exDate: '2026-11-05', type: 'dividend', amountPerShare: 5, futuresAdjusted: false, confidence: 'confirmed', ...over },
      ],
    });

  it('confirmed, unadjusted dividend in the holding window is income', () => {
    const o = div({});
    expect(o.economics!.dividendIncome).toBe(2500);
    expect(o.economics!.netProfit).toBeCloseTo(base + 2500, 6);
  });

  it('exchange-adjusted dividend is not double counted', () => {
    const o = div({ futuresAdjusted: true });
    expect(o.economics!.dividendIncome).toBe(0);
    expect(o.warnings.map((w) => w.code)).toContain('DIVIDEND_FUTURES_ADJUSTED');
  });

  it('uncertain dividend counts as zero with a warning', () => {
    const o = div({ confidence: 'estimated' });
    expect(o.economics!.dividendIncome).toBe(0);
    expect(o.warnings.map((w) => w.code)).toContain('DIVIDEND_UNCERTAIN');
  });

  it('events outside the window are ignored', () => {
    expect(div({ exDate: '2026-10-20' }).economics!.dividendIncome).toBe(0);
    expect(div({ exDate: '2026-11-20' }).economics!.dividendIncome).toBe(0);
  });
});

describe('helpers', () => {
  it('selects the schedule in force on the trade date', () => {
    expect(scheduleFor('2026-03-31').id).toBe('nse-2024-10');
    expect(scheduleFor('2026-04-01').id).toBe('nse-2026-04');
    expect(() => scheduleFor('2020-01-01')).toThrow();
  });

  it('counts calendar days', () => {
    expect(daysBetween('2026-10-20', '2026-11-19')).toBe(30);
    expect(daysBetween('2026-10-20', '2026-10-19')).toBe(-1);
  });

  it('fills from depth or returns null', () => {
    expect(fillFromDepth([{ price: 10, quantity: 5 }], 6)).toBeNull();
    expect(fillFromDepth([{ price: 10, quantity: 5 }, { price: 11, quantity: 5 }], 6)!.price).toBeCloseTo(61 / 6, 12);
  });

  it('quality score is bounded and explained', () => {
    const q = run().quality!;
    expect(q.score!).toBeGreaterThan(0);
    expect(q.score!).toBeLessThanOrEqual(100);
    expect(q.components.find((c) => c.key === 'basisStability')!.score).toBeNull();
  });
});
