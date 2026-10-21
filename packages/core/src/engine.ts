// Cash-and-carry calculation engine: buy the stock in the cash market, sell the stock future.
// Pure and deterministic: the same inputs (including `now`) always give the same output.

import { ANGEL_ONE_DEFAULT, type BrokerProfile } from './costs/broker';
import {
  chargesForTrade,
  summarizeCosts,
  type CostBreakdown,
  type CostItem,
  type Trade,
} from './costs/charges';
import { STATUTORY_SCHEDULES, scheduleFor, type StatutorySchedule } from './costs/schedules';
import { daysBetween, isExpired, istDate } from './dates';
import { fillFromDepth, spreadPct, totalDepthQuantity } from './pricing';
import {
  computeQuality,
  DEFAULT_QUALITY_WEIGHTS,
  type QualityScore,
  type QualityWeights,
} from './quality';
import type {
  Contract,
  CorporateAction,
  DataKind,
  ExclusionReason,
  ExitMode,
  OpportunityStatus,
  PriceMode,
  Quote,
  Warning,
} from './types';

export interface FundingConfig {
  /** Annual opportunity cost of own capital, as a fraction (0.07 = 7%). */
  ownCapitalRate: number;
  /** Share of the cash purchase financed by borrowing, 0..1. */
  borrowedFraction: number;
  /** Annual interest rate on borrowed capital, as a fraction. */
  borrowRate: number;
  /** Day-count basis for funding and annualization. */
  dayCountBasis: number;
}

export interface MarginConfig {
  /** Estimated futures margin as a fraction of futures contract value. */
  marginRate: number;
  /** Whether the purchased shares are pledged as margin collateral. */
  pledgeShares: boolean;
  /** Haircut applied to pledged shares, 0..1. */
  pledgeHaircut: number;
  /** Max share of margin that non-cash collateral may cover (exchange 50:50 rule). */
  maxCollateralShareOfMargin: number;
}

/**
 * Which net figure decides profitability, status and the rupee/return ranking metrics.
 * 'before_funding': net of transaction costs only (return on your own idle capital).
 * 'after_funding': also net of the funding/opportunity cost (excess over the funding rate).
 */
export type ProfitBasis = 'before_funding' | 'after_funding';

export interface CalcConfig {
  priceMode: PriceMode;
  exitMode: ExitMode;
  /** Number of futures lots per position. */
  lots: number;
  /** A quote older than this is stale and cannot be executable. */
  staleAfterMs: number;
  nearExpiryDays: number;
  /** Assumed exit slippage per leg in basis points (square-off only). */
  exitSlippageBps: number;
  /** Bid-ask spread (% of mid) above which a WIDE_SPREAD warning is raised. */
  wideSpreadPct: number;
  /** Futures/cash price ratio outside [1 - x, 1 + x] is treated as a data error. */
  maxBasisDeviation: number;
  funding: FundingConfig;
  profitBasis: ProfitBasis;
  margin: MarginConfig;
  broker: BrokerProfile;
  schedules: readonly StatutorySchedule[];
  /** Optional capital amount for the "net profit for an investment amount" metric. */
  investmentAmount: number | null;
  qualityWeights: QualityWeights;
}

export const DEFAULT_CALC_CONFIG: CalcConfig = {
  priceMode: 'bidask',
  exitMode: 'square_off',
  lots: 1,
  staleAfterMs: 15_000,
  nearExpiryDays: 3,
  exitSlippageBps: 0,
  wideSpreadPct: 0.25,
  maxBasisDeviation: 0.2,
  funding: { ownCapitalRate: 0.07, borrowedFraction: 0, borrowRate: 0.12, dayCountBasis: 365 },
  profitBasis: 'before_funding',
  margin: { marginRate: 0.2, pledgeShares: false, pledgeHaircut: 0.2, maxCollateralShareOfMargin: 0.5 },
  broker: ANGEL_ONE_DEFAULT,
  schedules: STATUTORY_SCHEDULES,
  investmentAmount: null,
  qualityWeights: DEFAULT_QUALITY_WEIGHTS,
};

export interface OpportunityInput {
  contract: Contract;
  cashQuote: Quote | null | undefined;
  futQuote: Quote | null | undefined;
  now: number;
  config: CalcConfig;
  corporateActions?: readonly CorporateAction[];
  /** Std-dev of historical basis as % of price, if history is available. */
  basisStdPct?: number | null;
  /** False outside the normal trading session; such rows are never executable. Default true. */
  marketOpen?: boolean;
}

export interface Economics {
  lots: number;
  quantity: number;
  cashBuyPrice: number;
  futSellPrice: number;
  /** Futures sell price − cash buy price, per share. */
  grossSpread: number;
  grossSpreadPct: number;
  grossSpreadValuePerLot: number;
  grossSpreadValueTotal: number;
  cashValue: number;
  futValue: number;
  /** Assumed price at which both legs converge at exit. */
  exitPriceEstimate: number;
  costs: CostBreakdown;
  holdingDays: number;
  fundingRateBlended: number;
  fundingCost: number;
  dividendIncome: number;
  netProfit: number;
  netProfitPerLot: number;
  /** Net profit / cash purchase value × 100. The ranking denominator. */
  netReturnPct: number;
  /** Net of costs and funding, annualized: the excess over the funding rate. null when holding days ≤ 0. */
  annualizedYieldPct: number | null;
  /** Gross spread − costs + income: what the trade earns on your own capital. */
  netProfitBeforeFunding: number;
  netProfitPerLotBeforeFunding: number;
  netReturnBeforeFundingPct: number;
  /** Net of costs only, annualized. null when holding days ≤ 0. */
  annualizedYieldBeforeFundingPct: number | null;
  /** True when the trade still makes money after the funding/opportunity cost. */
  beatsFundingRate: boolean;
  marginEstimate: number;
  collateralCredit: number;
  totalCapitalAllocated: number;
  /** Secondary measure on total allocated capital; never used for ranking. */
  netReturnOnAllocatedPct: number;
}

export interface Opportunity {
  key: string;
  contract: Contract;
  asOf: number;
  status: OpportunityStatus;
  dataKind: DataKind | null;
  priceMode: PriceMode;
  exitMode: ExitMode;
  exclusionReasons: ExclusionReason[];
  warnings: Warning[];
  daysToExpiry: number;
  quotes: {
    cashLtp: number | null;
    cashBid: number | null;
    cashAsk: number | null;
    futLtp: number | null;
    futBid: number | null;
    futAsk: number | null;
    cashSpreadPct: number | null;
    futSpreadPct: number | null;
    cashVolume: number | null;
    cashTurnover: number | null;
    futVolume: number | null;
    futTurnover: number | null;
    openInterest: number | null;
    cashAgeMs: number | null;
    futAgeMs: number | null;
    cashTimestamp: number | null;
    futTimestamp: number | null;
    /** Total visible quantity on the side we trade (cash asks, futures bids). */
    cashAskDepthQty: number;
    futBidDepthQty: number;
  };
  /** Basis at last traded prices; informational only, never executable. */
  ltpGrossSpread: number | null;
  economics: Economics | null;
  /** Net profit when deploying `config.investmentAmount` (whole lots only). */
  investment: { amount: number; lots: number; netProfit: number } | null;
  quality: QualityScore | null;
  assumptions: {
    scheduleId: string;
    brokerProfileId: string;
    lots: number;
    staleAfterMs: number;
    fundingRateBlended: number;
    dayCountBasis: number;
    exitSlippageBps: number;
    profitBasis: ProfitBasis;
  };
}

/** The net profit that counts under the configured profit basis. */
export function basisNetProfit(e: Economics, basis: ProfitBasis): number {
  return basis === 'before_funding' ? e.netProfitBeforeFunding : e.netProfit;
}

const EXPIRED_STATUS: Partial<Record<Contract['status'], ExclusionReason>> = {
  expired: 'CONTRACT_EXPIRED',
  suspended: 'CONTRACT_SUSPENDED',
  ban_period: 'CONTRACT_IN_BAN_PERIOD',
};

function blendedFundingRate(f: FundingConfig): number {
  const b = Math.min(1, Math.max(0, f.borrowedFraction));
  return (1 - b) * f.ownCapitalRate + b * f.borrowRate;
}

function dividendAdjustment(
  actions: readonly CorporateAction[],
  symbol: string,
  today: string,
  expiry: string,
  quantity: number,
): { income: number; warnings: Warning[] } {
  let income = 0;
  const warnings: Warning[] = [];
  for (const a of actions) {
    // Shares bought today (T+1) are held on any record date after today up to expiry.
    if (a.symbol !== symbol || !(a.exDate > today && a.exDate <= expiry)) continue;
    if (a.type !== 'dividend') {
      warnings.push({
        code: 'CORPORATE_ACTION_IN_WINDOW',
        message: `${a.description ?? 'Corporate action'} ex-date ${a.exDate} before expiry; exchange adjusts contract terms — review manually.`,
      });
      continue;
    }
    if (a.futuresAdjusted === true) {
      warnings.push({
        code: 'DIVIDEND_FUTURES_ADJUSTED',
        message: `Dividend ex ${a.exDate}: futures price is exchange-adjusted, so no separate income is counted.`,
      });
      continue;
    }
    const known =
      a.futuresAdjusted === false &&
      a.confidence === 'confirmed' &&
      typeof a.amountPerShare === 'number' &&
      a.amountPerShare > 0;
    if (known) {
      income += a.amountPerShare! * quantity;
      warnings.push({
        code: 'DIVIDEND_IN_WINDOW',
        message: `Dividend ₹${a.amountPerShare} ex ${a.exDate} counted as income (pre-tax).`,
      });
    } else {
      warnings.push({
        code: 'DIVIDEND_UNCERTAIN',
        message: `Dividend ex ${a.exDate} is unconfirmed or its futures treatment is unknown; conservatively counted as zero.`,
      });
    }
  }
  return { income, warnings };
}

/** Full economics for a given price pair and lot count. Inputs must already be validated. */
export function computeEconomics(args: {
  contract: Contract;
  cashBuyPrice: number;
  futSellPrice: number;
  lots: number;
  today: string;
  config: CalcConfig;
  corporateActions?: readonly CorporateAction[];
}): { economics: Economics; warnings: Warning[] } {
  const { contract, cashBuyPrice, futSellPrice, lots, today, config } = args;
  const schedule = scheduleFor(today, config.schedules);
  const quantity = lots * contract.lotSize;
  const cashValue = cashBuyPrice * quantity;
  const futValue = futSellPrice * quantity;
  const grossSpread = futSellPrice - cashBuyPrice;

  // Legs converge at expiry; the exit level only scales value-based exit charges.
  const exitPriceEstimate = cashBuyPrice;
  const exitValue = exitPriceEstimate * quantity;

  const trades: Trade[] = [
    { leg: 'cash', phase: 'entry', kind: 'equity_delivery', side: 'buy', value: cashValue },
    { leg: 'futures', phase: 'entry', kind: 'futures', side: 'sell', value: futValue },
  ];
  if (config.exitMode === 'square_off') {
    trades.push(
      { leg: 'cash', phase: 'exit', kind: 'equity_delivery', side: 'sell', value: exitValue },
      { leg: 'futures', phase: 'exit', kind: 'futures', side: 'buy', value: exitValue },
    );
  } else {
    trades.push({ leg: 'cash', phase: 'exit', kind: 'physical_settlement', side: 'sell', value: exitValue });
  }
  const items: CostItem[] = trades.flatMap((t) => chargesForTrade(t, schedule, config.broker));
  if (config.exitMode === 'square_off' && config.exitSlippageBps > 0) {
    const rate = config.exitSlippageBps / 10_000;
    for (const leg of ['cash', 'futures'] as const) {
      items.push({
        leg,
        phase: 'exit',
        component: 'slippage',
        amount: rate * exitValue,
        rate,
        base: exitValue,
        estimate: true,
        note: `Assumed ${config.exitSlippageBps} bps exit slippage`,
      });
    }
  }
  const costs = summarizeCosts(items, schedule.id, config.broker.id);

  const holdingDays = Math.max(0, daysBetween(today, contract.expiry));
  const fundingRateBlended = blendedFundingRate(config.funding);
  const fundingCost = (cashValue * fundingRateBlended * holdingDays) / config.funding.dayCountBasis;

  const div = dividendAdjustment(
    args.corporateActions ?? [],
    contract.symbol,
    today,
    contract.expiry,
    quantity,
  );

  const grossSpreadValueTotal = grossSpread * quantity;
  const netProfitBeforeFunding = grossSpreadValueTotal - costs.total + div.income;
  const netProfit = netProfitBeforeFunding - fundingCost;
  const netReturn = netProfit / cashValue;
  const netReturnBeforeFunding = netProfitBeforeFunding / cashValue;
  const annualize = (r: number) =>
    holdingDays > 0 ? r * (config.funding.dayCountBasis / holdingDays) * 100 : null;

  const m = config.margin;
  const marginEstimate = futValue * m.marginRate;
  const collateralCredit = m.pledgeShares
    ? Math.min(marginEstimate * m.maxCollateralShareOfMargin, cashValue * (1 - m.pledgeHaircut))
    : 0;
  const totalCapitalAllocated = cashValue + (marginEstimate - collateralCredit);

  const warnings: Warning[] = [
    ...div.warnings,
    {
      code: 'EXIT_PRICE_ESTIMATED',
      message: 'Exit charges assume both legs converge at the current cash price.',
    },
    {
      code: 'BROKERAGE_ESTIMATED',
      message: `Brokerage and DP charges use the "${config.broker.name}" profile; confirm against contract notes.`,
    },
  ];

  return {
    economics: {
      lots,
      quantity,
      cashBuyPrice,
      futSellPrice,
      grossSpread,
      grossSpreadPct: (grossSpread / cashBuyPrice) * 100,
      grossSpreadValuePerLot: grossSpread * contract.lotSize,
      grossSpreadValueTotal,
      cashValue,
      futValue,
      exitPriceEstimate,
      costs,
      holdingDays,
      fundingRateBlended,
      fundingCost,
      dividendIncome: div.income,
      netProfit,
      netProfitPerLot: netProfit / lots,
      netReturnPct: netReturn * 100,
      annualizedYieldPct: annualize(netReturn),
      netProfitBeforeFunding,
      netProfitPerLotBeforeFunding: netProfitBeforeFunding / lots,
      netReturnBeforeFundingPct: netReturnBeforeFunding * 100,
      annualizedYieldBeforeFundingPct: annualize(netReturnBeforeFunding),
      beatsFundingRate: netProfit > 0,
      marginEstimate,
      collateralCredit,
      totalCapitalAllocated,
      netReturnOnAllocatedPct: (netProfit / totalCapitalAllocated) * 100,
    },
    warnings,
  };
}

function validPrice(p: number | null | undefined): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p > 0;
}

export function computeOpportunity(input: OpportunityInput): Opportunity {
  const { contract, now, config } = input;
  const cash = input.cashQuote ?? null;
  const fut = input.futQuote ?? null;
  const today = istDate(now);
  const daysToExpiry = daysBetween(today, contract.expiry);
  const quantity = config.lots * contract.lotSize;
  const reasons: ExclusionReason[] = [];
  const warnings: Warning[] = [];

  // --- Contract-level checks
  const statusReason = EXPIRED_STATUS[contract.status];
  if (statusReason) reasons.push(statusReason);
  if (isExpired(contract.expiry, now)) reasons.push('CONTRACT_EXPIRED');
  if (!Number.isInteger(contract.lotSize) || contract.lotSize <= 0 || !(config.lots >= 1)) {
    reasons.push('INVALID_LOT_SIZE');
  }

  if (input.marketOpen === false) reasons.push('MARKET_CLOSED');

  // --- Quote presence, identity, tradability, freshness
  if (!cash) reasons.push('MISSING_CASH_QUOTE');
  if (!fut) reasons.push('MISSING_FUT_QUOTE');
  if ((cash && cash.token !== contract.cashToken) || (fut && fut.token !== contract.futToken)) {
    reasons.push('TOKEN_MISMATCH');
  }
  if (cash && !cash.tradable) reasons.push('CASH_NOT_TRADABLE');
  if (fut && !fut.tradable) reasons.push('FUT_NOT_TRADABLE');
  const cashAgeMs = cash ? Math.max(0, now - cash.receivedAt) : null;
  const futAgeMs = fut ? Math.max(0, now - fut.receivedAt) : null;
  if (cashAgeMs !== null && cashAgeMs > config.staleAfterMs) reasons.push('STALE_CASH_QUOTE');
  if (futAgeMs !== null && futAgeMs > config.staleAfterMs) reasons.push('STALE_FUT_QUOTE');

  // --- Executable price selection
  let cashBuy: number | null = null;
  let futSell: number | null = null;
  if (cash && fut) {
    if (config.priceMode === 'ltp') {
      if (validPrice(cash.ltp)) cashBuy = cash.ltp;
      else reasons.push('NO_CASH_LTP');
      if (validPrice(fut.ltp)) futSell = fut.ltp;
      else reasons.push('NO_FUT_LTP');
    } else if (config.priceMode === 'bidask') {
      const ask = cash.asks[0];
      const bid = fut.bids[0];
      if (ask && validPrice(ask.price)) cashBuy = ask.price;
      else reasons.push('NO_CASH_ASK');
      if (bid && validPrice(bid.price)) futSell = bid.price;
      else reasons.push('NO_FUT_BID');
      if ((ask && ask.quantity < quantity) || (bid && bid.quantity < quantity)) {
        warnings.push({
          code: 'TOP_OF_BOOK_QTY_LOW',
          message: `Best-level quantity is below the intended ${quantity} shares; switch to depth mode for a fill estimate.`,
        });
      }
    } else {
      if (!cash.asks.length) reasons.push('NO_CASH_ASK');
      else {
        const f = fillFromDepth(cash.asks, quantity);
        if (f) cashBuy = f.price;
        else reasons.push('INSUFFICIENT_CASH_DEPTH');
      }
      if (!fut.bids.length) reasons.push('NO_FUT_BID');
      else {
        const f = fillFromDepth(fut.bids, quantity);
        if (f) futSell = f.price;
        else reasons.push('INSUFFICIENT_FUT_DEPTH');
      }
    }
    // Best bid at or above best ask cannot persist in continuous trading: the book is in an
    // auction (e.g. the cash Closing Auction Session) or the data is bad.
    const crossed = (q: Quote) => !!q.bids[0] && !!q.asks[0] && q.bids[0].price >= q.asks[0].price;
    if (crossed(cash) || crossed(fut)) reasons.push('CROSSED_BOOK');
    if (cashBuy !== null && futSell !== null) {
      const ratio = futSell / cashBuy;
      if (Math.abs(ratio - 1) > config.maxBasisDeviation) reasons.push('INVALID_PRICE');
    }
  }

  // --- Display fields (populated even for excluded rows, for diagnostics)
  const cashSpreadPct = cash ? spreadPct(cash.bids, cash.asks) : null;
  const futSpreadPct = fut ? spreadPct(fut.bids, fut.asks) : null;
  const quotes: Opportunity['quotes'] = {
    cashLtp: cash?.ltp ?? null,
    cashBid: cash?.bids[0]?.price ?? null,
    cashAsk: cash?.asks[0]?.price ?? null,
    futLtp: fut?.ltp ?? null,
    futBid: fut?.bids[0]?.price ?? null,
    futAsk: fut?.asks[0]?.price ?? null,
    cashSpreadPct,
    futSpreadPct,
    cashVolume: cash?.volume ?? null,
    cashTurnover: cash?.turnover ?? null,
    futVolume: fut?.volume ?? null,
    futTurnover: fut?.turnover ?? null,
    openInterest: fut?.openInterest ?? null,
    cashAgeMs,
    futAgeMs,
    cashTimestamp: cash?.exchangeTimestamp ?? null,
    futTimestamp: fut?.exchangeTimestamp ?? null,
    cashAskDepthQty: cash ? totalDepthQuantity(cash.asks) : 0,
    futBidDepthQty: fut ? totalDepthQuantity(fut.bids) : 0,
  };
  const ltpGrossSpread =
    validPrice(cash?.ltp) && validPrice(fut?.ltp) ? fut!.ltp! - cash!.ltp! : null;

  // Weakest data kind of the two legs decides executability.
  const kinds = [cash?.dataKind, fut?.dataKind].filter((k): k is DataKind => !!k);
  const dataKind: DataKind | null =
    kinds.length === 0 ? null : kinds.find((k) => k !== 'live') ?? 'live';

  if (daysToExpiry === 0) {
    warnings.push({ code: 'EXPIRY_DAY', message: 'Contract expires today; annualized yield is not calculated.' });
  } else if (daysToExpiry > 0 && daysToExpiry <= config.nearExpiryDays) {
    warnings.push({ code: 'NEAR_EXPIRY', message: `Contract expires in ${daysToExpiry} day(s).` });
  }
  if (
    (cashSpreadPct !== null && cashSpreadPct > config.wideSpreadPct) ||
    (futSpreadPct !== null && futSpreadPct > config.wideSpreadPct)
  ) {
    warnings.push({
      code: 'WIDE_SPREAD',
      message: `A bid–ask spread exceeds ${config.wideSpreadPct}% of mid.`,
    });
  }
  if (dataKind === 'sample') {
    warnings.push({ code: 'SAMPLE_DATA', message: 'SAMPLE DATA — simulated prices, not market quotes.' });
  } else if (dataKind && dataKind !== 'live') {
    warnings.push({ code: 'NON_LIVE_DATA', message: `Data is ${dataKind}, not live; shown for research only.` });
  }
  if (config.priceMode === 'ltp') {
    warnings.push({
      code: 'THEORETICAL_LTP_MODE',
      message: 'Calculated from last traded prices; theoretical only, never executable.',
    });
  }

  const schedule = scheduleFor(today, config.schedules);
  const assumptions: Opportunity['assumptions'] = {
    scheduleId: schedule.id,
    brokerProfileId: config.broker.id,
    lots: config.lots,
    staleAfterMs: config.staleAfterMs,
    fundingRateBlended: blendedFundingRate(config.funding),
    dayCountBasis: config.funding.dayCountBasis,
    exitSlippageBps: config.exitSlippageBps,
    profitBasis: config.profitBasis,
  };

  const base = {
    key: contract.futToken,
    contract,
    asOf: now,
    dataKind,
    priceMode: config.priceMode,
    exitMode: config.exitMode,
    daysToExpiry,
    quotes,
    ltpGrossSpread,
    assumptions,
  };

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0 || cashBuy === null || futSell === null) {
    return {
      ...base,
      status: 'excluded',
      exclusionReasons: uniqueReasons,
      warnings,
      economics: null,
      investment: null,
      quality: null,
    };
  }

  const { economics, warnings: econWarnings } = computeEconomics({
    contract,
    cashBuyPrice: cashBuy,
    futSellPrice: futSell,
    lots: config.lots,
    today,
    config,
    corporateActions: input.corporateActions,
  });

  let investment: Opportunity['investment'] = null;
  if (config.investmentAmount !== null && config.investmentAmount > 0) {
    const lots = Math.floor(config.investmentAmount / (cashBuy * contract.lotSize));
    investment = {
      amount: config.investmentAmount,
      lots,
      netProfit:
        lots >= 1
          ? basisNetProfit(computeEconomics({
              contract,
              cashBuyPrice: cashBuy,
              futSellPrice: futSell,
              lots,
              today,
              config,
              corporateActions: input.corporateActions,
            }).economics, config.profitBasis)
          : 0,
    };
  }

  const expectedFields = [
    cash!.ltp,
    cash!.bids[0],
    cash!.asks[0],
    cash!.volume,
    cash!.turnover,
    fut!.ltp,
    fut!.bids[0],
    fut!.asks[0],
    fut!.volume,
    fut!.turnover,
    fut!.openInterest,
  ];
  const quality = computeQuality(
    {
      maxQuoteAgeMs: Math.max(cashAgeMs ?? 0, futAgeMs ?? 0),
      staleAfterMs: config.staleAfterMs,
      cashTurnover: cash!.turnover,
      futTurnover: fut!.turnover,
      cashSpreadPct,
      futSpreadPct,
      cashAskDepthQty: quotes.cashAskDepthQty,
      futBidDepthQty: quotes.futBidDepthQty,
      requiredQty: quantity,
      totalCosts: economics.costs.total,
      grossSpreadValueTotal: economics.grossSpreadValueTotal,
      basisStdPct: input.basisStdPct ?? null,
      completeness: expectedFields.filter((v) => v !== null && v !== undefined).length / expectedFields.length,
    },
    config.qualityWeights,
  );

  const executableData = dataKind === 'live' || dataKind === 'sample';
  const status: OpportunityStatus =
    config.priceMode === 'ltp' || !executableData
      ? 'research'
      : basisNetProfit(economics, config.profitBasis) > 0
        ? 'executable'
        : 'unprofitable';

  return {
    ...base,
    status,
    exclusionReasons: [],
    warnings: [...warnings, ...econWarnings],
    economics,
    investment,
    quality,
  };
}
