// End-of-day "closing prices" view: every contract calculated from last traded prices after
// the close (cash = closing-auction price, futures = last traded price). LTP mode makes the
// engine mark every row as research, so it can never be mistaken for an executable opportunity.

import {
  applySettings,
  computeOpportunity,
  istDate,
  summarize,
  toWireRow,
  type Contract,
  type Quote,
  type WireFeed,
  type WireMessage,
} from '@arb/core';

export function buildCloseMessage(args: {
  contracts: readonly Contract[];
  quote: (token: string) => Quote | undefined;
  marginRate?: (futToken: string) => number | null;
  now: number;
  settingsRaw: Record<string, unknown>;
  feed: WireFeed;
  version: string;
}): WireMessage {
  const { contracts, quote, now, settingsRaw } = args;
  const config = { ...applySettings(settingsRaw), priceMode: 'ltp' as const, staleAfterMs: Number.MAX_SAFE_INTEGER };
  const opps = contracts.map((c) =>
    computeOpportunity({
      contract: c,
      cashQuote: quote(c.cashToken),
      futQuote: quote(c.futToken),
      now,
      config,
      marginRate: args.marginRate?.(c.futToken) ?? null,
    }),
  );
  // The trading date is the one the quotes belong to, not the wall-clock date.
  const latest = Math.max(
    0,
    ...contracts.flatMap((c) => [quote(c.cashToken)?.exchangeTimestamp ?? 0, quote(c.futToken)?.exchangeTimestamp ?? 0]),
  );
  const s = summarize(opps);
  return {
    kind: 'close',
    tradeDate: istDate(latest > 0 ? latest : now),
    at: now,
    version: args.version,
    feed: args.feed,
    summary: {
      stocks: s.stocks,
      contracts: s.contracts,
      executable: 0,
      beatingFundingRate: 0,
      unprofitable: s.unprofitable,
      research: s.research,
      excluded: s.excluded,
      stale: s.stale,
      passingQuality: 0,
      bestYieldAfterCosts: null,
      bestNetProfitPerLot: null,
    },
    settings: settingsRaw,
    rows: opps.map(toWireRow),
  };
}
