// Broker-specific charges. These vary by plan and account, so they are user-configurable
// and always reported as estimates.

export type BrokerageRule =
  | { type: 'zero' }
  | { type: 'flat'; amount: number }
  /** rate x value, capped at `cap`, with an optional floor `min`. */
  | { type: 'percent_capped'; rate: number; cap: number; min?: number };

export interface BrokerProfile {
  id: string;
  name: string;
  /** Per executed order. */
  equityDelivery: BrokerageRule;
  /** Per executed order. */
  futures: BrokerageRule;
  /** Charged when a futures position is settled by physical delivery. */
  physicalSettlement: BrokerageRule;
  /** Depository charge per scrip per sell (debit) day, before GST. */
  dpChargePerScrip: number;
  source: string;
  verifiedOn: string;
}

/** Conservative defaults for Angel One; confirm against your own contract notes. */
export const ANGEL_ONE_DEFAULT: BrokerProfile = {
  id: 'angel-one-default',
  name: 'Angel One (estimated)',
  equityDelivery: { type: 'percent_capped', rate: 0.001, cap: 20, min: 0 },
  futures: { type: 'flat', amount: 20 },
  physicalSettlement: { type: 'percent_capped', rate: 0.001, cap: 20, min: 0 },
  dpChargePerScrip: 20,
  source: 'Public Angel One charge listings (aggregators disagree on delivery brokerage; conservative choice used)',
  verifiedOn: '2026-10-20',
};

export function brokerageFor(rule: BrokerageRule, value: number): number {
  switch (rule.type) {
    case 'zero':
      return 0;
    case 'flat':
      return rule.amount;
    case 'percent_capped':
      return Math.max(rule.min ?? 0, Math.min(rule.rate * value, rule.cap));
  }
}
