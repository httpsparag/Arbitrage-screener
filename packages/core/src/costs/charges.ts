import { brokerageFor, type BrokerProfile } from './broker';
import type { StatutorySchedule } from './schedules';

export type TradeKind = 'equity_delivery' | 'futures' | 'physical_settlement';
export type Leg = 'cash' | 'futures';
export type Phase = 'entry' | 'exit';
export type CostComponent =
  | 'brokerage'
  | 'stt'
  | 'exchange'
  | 'sebi'
  | 'ipft'
  | 'stamp'
  | 'dp'
  | 'gst'
  | 'slippage';

export interface Trade {
  leg: Leg;
  phase: Phase;
  kind: TradeKind;
  side: 'buy' | 'sell';
  /** Traded (or settlement) value in rupees. */
  value: number;
}

export interface CostItem {
  leg: Leg;
  phase: Phase;
  component: CostComponent;
  amount: number;
  /** Rate applied to `base`, when the charge is proportional. */
  rate: number | null;
  base: number;
  /** True when the figure depends on broker/account assumptions rather than statute. */
  estimate: boolean;
  note?: string;
}

export interface CostBreakdown {
  items: CostItem[];
  total: number;
  byLeg: Record<Leg, number>;
  byPhase: Record<Phase, number>;
  byComponent: Record<CostComponent, number>;
  scheduleId: string;
  brokerProfileId: string;
}

/** All charges for one executed trade, including GST on the taxable components. */
export function chargesForTrade(
  trade: Trade,
  schedule: StatutorySchedule,
  broker: BrokerProfile,
): CostItem[] {
  const { leg, phase, kind, side, value } = trade;
  const items: CostItem[] = [];
  const add = (
    component: CostComponent,
    rate: number | null,
    amount: number,
    estimate: boolean,
    note?: string,
  ) => {
    if (amount !== 0) items.push({ leg, phase, component, amount, rate, base: value, estimate, note });
  };
  const pct = (component: CostComponent, rate: number, estimate = false, note?: string) =>
    add(component, rate, rate * value, estimate, note);

  const rule =
    kind === 'equity_delivery'
      ? broker.equityDelivery
      : kind === 'futures'
        ? broker.futures
        : broker.physicalSettlement;
  add('brokerage', null, brokerageFor(rule, value), true, broker.name);

  if (kind === 'equity_delivery') {
    pct('stt', side === 'buy' ? schedule.stt.deliveryBuy : schedule.stt.deliverySell);
    pct('exchange', schedule.exchangeTxn.equity);
    if (side === 'buy') pct('stamp', schedule.stampDuty.deliveryBuy);
  } else if (kind === 'futures') {
    if (side === 'sell') pct('stt', schedule.stt.futuresSell);
    pct('exchange', schedule.exchangeTxn.futures);
    if (side === 'buy') pct('stamp', schedule.stampDuty.futuresBuy);
  } else {
    // Physical settlement of a short futures position: we deliver the shares.
    pct('stt', schedule.stt.physicalSettlementSell);
    pct('exchange', schedule.exchangeTxn.equity, true, 'Assumed equity-segment rate on settlement value');
  }
  pct('sebi', schedule.sebiFee);
  pct('ipft', schedule.ipft);

  const deliversShares =
    (kind === 'equity_delivery' && side === 'sell') || kind === 'physical_settlement';
  if (deliversShares) add('dp', null, broker.dpChargePerScrip, true, 'Per scrip debit');

  const gstBase = items
    .filter((i) => ['brokerage', 'exchange', 'sebi', 'ipft', 'dp'].includes(i.component))
    .reduce((s, i) => s + i.amount, 0);
  add('gst', schedule.gst, schedule.gst * gstBase, false, 'On brokerage, exchange, SEBI, IPFT and DP charges');
  // GST's base differs from the trade value; record it explicitly.
  const gst = items[items.length - 1];
  if (gst && gst.component === 'gst') gst.base = gstBase;

  return items;
}

export function summarizeCosts(
  items: CostItem[],
  scheduleId: string,
  brokerProfileId: string,
): CostBreakdown {
  const byLeg: Record<Leg, number> = { cash: 0, futures: 0 };
  const byPhase: Record<Phase, number> = { entry: 0, exit: 0 };
  const byComponent: Record<CostComponent, number> = {
    brokerage: 0,
    stt: 0,
    exchange: 0,
    sebi: 0,
    ipft: 0,
    stamp: 0,
    dp: 0,
    gst: 0,
    slippage: 0,
  };
  let total = 0;
  for (const i of items) {
    total += i.amount;
    byLeg[i.leg] += i.amount;
    byPhase[i.phase] += i.amount;
    byComponent[i.component] += i.amount;
  }
  return { items, total, byLeg, byPhase, byComponent, scheduleId, brokerProfileId };
}
