// User-editable calculation settings (stored in Supabase `user_settings.calc_config`).
// Both the worker and the dashboard merge them over the defaults the same way,
// so the phone's detail view reproduces the worker's numbers exactly.

import { DEFAULT_CALC_CONFIG, type CalcConfig, type ProfitBasis } from './engine';
import type { ExitMode, PriceMode } from './types';

export interface UserCalcSettings {
  priceMode?: PriceMode;
  exitMode?: ExitMode;
  lots?: number;
  profitBasis?: ProfitBasis;
  /** Annual funding / opportunity rate in percent, e.g. 7 for 7%. */
  fundingRatePct?: number;
  /** Share of purchase financed by borrowing, percent 0–100. */
  borrowedPct?: number;
  borrowRatePct?: number;
  exitSlippageBps?: number;
  investmentAmount?: number | null;
  staleAfterSeconds?: number;
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

/** Drops unknown keys and out-of-range values, so bad stored settings can never break a calculation. */
export function sanitizeSettings(raw: unknown): UserCalcSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: UserCalcSettings = {
    priceMode: oneOf(r.priceMode, ['ltp', 'bidask', 'depth'] as const),
    exitMode: oneOf(r.exitMode, ['square_off', 'physical_settlement'] as const),
    lots: num(r.lots, 1, 100),
    profitBasis: oneOf(r.profitBasis, ['before_funding', 'after_funding'] as const),
    fundingRatePct: num(r.fundingRatePct, 0, 50),
    borrowedPct: num(r.borrowedPct, 0, 100),
    borrowRatePct: num(r.borrowRatePct, 0, 50),
    exitSlippageBps: num(r.exitSlippageBps, 0, 100),
    investmentAmount: r.investmentAmount === null ? null : num(r.investmentAmount, 1, 1e10),
    staleAfterSeconds: num(r.staleAfterSeconds, 2, 600),
  };
  if (out.lots !== undefined) out.lots = Math.floor(out.lots);
  for (const k of Object.keys(out) as (keyof UserCalcSettings)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function applySettings(settings: UserCalcSettings, base: CalcConfig = DEFAULT_CALC_CONFIG): CalcConfig {
  const s = sanitizeSettings(settings);
  return {
    ...base,
    priceMode: s.priceMode ?? base.priceMode,
    exitMode: s.exitMode ?? base.exitMode,
    lots: s.lots ?? base.lots,
    profitBasis: s.profitBasis ?? base.profitBasis,
    exitSlippageBps: s.exitSlippageBps ?? base.exitSlippageBps,
    investmentAmount: s.investmentAmount !== undefined ? s.investmentAmount : base.investmentAmount,
    staleAfterMs: s.staleAfterSeconds !== undefined ? s.staleAfterSeconds * 1000 : base.staleAfterMs,
    funding: {
      ...base.funding,
      ownCapitalRate: s.fundingRatePct !== undefined ? s.fundingRatePct / 100 : base.funding.ownCapitalRate,
      borrowedFraction: s.borrowedPct !== undefined ? s.borrowedPct / 100 : base.funding.borrowedFraction,
      borrowRate: s.borrowRatePct !== undefined ? s.borrowRatePct / 100 : base.funding.borrowRate,
    },
  };
}
