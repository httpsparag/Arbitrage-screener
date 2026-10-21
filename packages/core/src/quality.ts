// Explainable opportunity-quality score. Each component maps an observable input to 0..1;
// the score is the weighted mean of available components, scaled to 0..100.
// It complements, and never replaces, estimated net profit and yield.

export type QualityKey =
  | 'freshness'
  | 'cashLiquidity'
  | 'futLiquidity'
  | 'spreads'
  | 'depth'
  | 'costEfficiency'
  | 'basisStability'
  | 'completeness';

export type QualityWeights = Record<QualityKey, number>;

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  freshness: 1,
  cashLiquidity: 1,
  futLiquidity: 1,
  spreads: 1,
  depth: 1,
  costEfficiency: 1,
  basisStability: 0.5,
  completeness: 0.5,
};

export interface QualityInput {
  maxQuoteAgeMs: number;
  staleAfterMs: number;
  cashTurnover: number | null;
  futTurnover: number | null;
  cashSpreadPct: number | null;
  futSpreadPct: number | null;
  cashAskDepthQty: number;
  futBidDepthQty: number;
  requiredQty: number;
  totalCosts: number | null;
  grossSpreadValueTotal: number | null;
  /** Standard deviation of historical basis, % of price; null when history is unavailable. */
  basisStdPct: number | null;
  /** Share of expected quote fields present, 0..1. */
  completeness: number;
}

export interface QualityComponent {
  key: QualityKey;
  label: string;
  /** 0..1, or null when the input is unavailable (excluded from the weighted mean). */
  score: number | null;
  weight: number;
  detail: string;
}

export interface QualityScore {
  /** 0..100, or null when no component could be scored. */
  score: number | null;
  components: QualityComponent[];
  method: string;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Log-scale score: `lo` rupees -> 0, `hi` rupees -> 1. */
function logScale(value: number | null, lo: number, hi: number): number | null {
  if (value === null || !(value >= 0)) return null;
  if (value <= lo) return 0;
  return clamp01((Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)));
}

const crore = (v: number | null) => (v === null ? 'n/a' : `₹${(v / 1e7).toFixed(1)} cr`);

export function computeQuality(
  input: QualityInput,
  weights: QualityWeights = DEFAULT_QUALITY_WEIGHTS,
): QualityScore {
  const freshFloor = input.staleAfterMs / 4;
  const freshness = clamp01(
    1 - (input.maxQuoteAgeMs - freshFloor) / Math.max(1, input.staleAfterMs - freshFloor),
  );

  const spreadScores = [input.cashSpreadPct, input.futSpreadPct]
    .filter((s): s is number => s !== null)
    .map((s) => clamp01(1 - s / 0.5));
  const spreads =
    spreadScores.length === 2 ? Math.min(spreadScores[0]!, spreadScores[1]!) : null;

  const coverage =
    input.requiredQty > 0
      ? Math.min(input.cashAskDepthQty, input.futBidDepthQty) / input.requiredQty
      : 0;

  const costEfficiency =
    input.totalCosts !== null && input.grossSpreadValueTotal !== null
      ? input.grossSpreadValueTotal > 0
        ? clamp01(1 - input.totalCosts / input.grossSpreadValueTotal)
        : 0
      : null;

  const basisStability =
    input.basisStdPct === null ? null : clamp01(1 - input.basisStdPct / 0.5);

  const components: QualityComponent[] = [
    {
      key: 'freshness',
      label: 'Quote freshness',
      score: freshness,
      weight: weights.freshness,
      detail: `Oldest leg ${(input.maxQuoteAgeMs / 1000).toFixed(1)}s; full score ≤ ${(freshFloor / 1000).toFixed(1)}s, zero at ${(input.staleAfterMs / 1000).toFixed(0)}s`,
    },
    {
      key: 'cashLiquidity',
      label: 'Cash liquidity',
      score: logScale(input.cashTurnover, 1e7, 1e10),
      weight: weights.cashLiquidity,
      detail: `Turnover ${crore(input.cashTurnover)} (log scale ₹1 cr → ₹1,000 cr)`,
    },
    {
      key: 'futLiquidity',
      label: 'Futures liquidity',
      score: logScale(input.futTurnover, 1e7, 5e9),
      weight: weights.futLiquidity,
      detail: `Turnover ${crore(input.futTurnover)} (log scale ₹1 cr → ₹500 cr)`,
    },
    {
      key: 'spreads',
      label: 'Bid–ask spreads',
      score: spreads,
      weight: weights.spreads,
      detail: `Cash ${input.cashSpreadPct?.toFixed(3) ?? 'n/a'}%, futures ${input.futSpreadPct?.toFixed(3) ?? 'n/a'}%; worse leg scored, zero at 0.5%`,
    },
    {
      key: 'depth',
      label: 'Market depth',
      score: clamp01(coverage / 5),
      weight: weights.depth,
      detail: `Visible depth covers ${coverage.toFixed(1)}× the intended quantity on the thinner leg; full score at 5×`,
    },
    {
      key: 'costEfficiency',
      label: 'Cost efficiency',
      score: costEfficiency,
      weight: weights.costEfficiency,
      detail: 'Share of gross spread left after transaction costs',
    },
    {
      key: 'basisStability',
      label: 'Basis stability',
      score: basisStability,
      weight: weights.basisStability,
      detail:
        input.basisStdPct === null
          ? 'No basis history yet'
          : `Basis std-dev ${input.basisStdPct.toFixed(3)}%; zero at 0.5%`,
    },
    {
      key: 'completeness',
      label: 'Data completeness',
      score: clamp01(input.completeness),
      weight: weights.completeness,
      detail: `${Math.round(input.completeness * 100)}% of expected quote fields present`,
    },
  ];

  let wsum = 0;
  let total = 0;
  for (const c of components) {
    if (c.score === null || c.weight <= 0) continue;
    wsum += c.weight;
    total += c.weight * c.score;
  }
  return {
    score: wsum > 0 ? (total / wsum) * 100 : null,
    components,
    method: 'Weighted mean of available component scores (each 0–1) × 100; unavailable components are skipped.',
  };
}
