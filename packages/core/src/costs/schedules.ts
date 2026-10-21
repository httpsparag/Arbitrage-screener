// Statutory and exchange charge schedules, as fractions of traded value.
// Each schedule is dated so historical calculations stay reproducible.
// Re-verify against NSE circulars / broker charge pages whenever rates change.

export interface StatutorySchedule {
  id: string;
  /** First trade date (YYYY-MM-DD, IST) this schedule applies to. */
  effectiveFrom: string;
  source: string;
  verifiedOn: string;
  stt: {
    /** Equity delivery, buy side. */
    deliveryBuy: number;
    /** Equity delivery, sell side. */
    deliverySell: number;
    /** Stock futures, sell side (on traded value). */
    futuresSell: number;
    /** Physically settled stock futures: STT on settlement value, seller side. */
    physicalSettlementSell: number;
  };
  exchangeTxn: {
    /** NSE equity cash segment. */
    equity: number;
    /** NSE equity futures. */
    futures: number;
  };
  /** SEBI turnover fee (Rs 10 per crore). */
  sebiFee: number;
  /** NSE Investor Protection Fund Trust charge (Rs 10 per crore). */
  ipft: number;
  stampDuty: {
    /** Equity delivery, buy side only. */
    deliveryBuy: number;
    /** Futures, buy side only. */
    futuresBuy: number;
  };
  /** GST on brokerage, exchange, SEBI, IPFT and DP charges. */
  gst: number;
}

export const STATUTORY_SCHEDULES: readonly StatutorySchedule[] = [
  {
    id: 'nse-2024-10',
    effectiveFrom: '2024-10-01',
    source: 'Finance (No. 2) Act 2024 STT rates; NSE exchange charge circulars',
    verifiedOn: '2026-10-20',
    stt: { deliveryBuy: 0.001, deliverySell: 0.001, futuresSell: 0.0002, physicalSettlementSell: 0.001 },
    exchangeTxn: { equity: 0.0000307, futures: 0.0000183 },
    sebiFee: 0.000001,
    ipft: 0.000001,
    stampDuty: { deliveryBuy: 0.00015, futuresBuy: 0.00002 },
    gst: 0.18,
  },
  {
    id: 'nse-2026-04',
    effectiveFrom: '2026-04-01',
    source: 'Union Budget 2026-27: futures STT raised 0.02% -> 0.05%; NSE exchange charge circulars',
    verifiedOn: '2026-10-20',
    stt: { deliveryBuy: 0.001, deliverySell: 0.001, futuresSell: 0.0005, physicalSettlementSell: 0.001 },
    exchangeTxn: { equity: 0.0000307, futures: 0.0000183 },
    sebiFee: 0.000001,
    ipft: 0.000001,
    stampDuty: { deliveryBuy: 0.00015, futuresBuy: 0.00002 },
    gst: 0.18,
  },
];

/** Returns the schedule in force on the given IST date (YYYY-MM-DD). */
export function scheduleFor(
  tradeDate: string,
  schedules: readonly StatutorySchedule[] = STATUTORY_SCHEDULES,
): StatutorySchedule {
  let chosen: StatutorySchedule | undefined;
  for (const s of schedules) {
    if (s.effectiveFrom <= tradeDate && (!chosen || s.effectiveFrom > chosen.effectiveFrom)) {
      chosen = s;
    }
  }
  if (!chosen) throw new Error(`No statutory charge schedule covers ${tradeDate}`);
  return chosen;
}
