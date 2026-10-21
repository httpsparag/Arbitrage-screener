import type { DepthLevel } from './types';

export interface Fill {
  /** Volume-weighted average price for the filled quantity. */
  price: number;
  quantity: number;
  levelsUsed: number;
}

/**
 * Walks the book (best level first) to fill `quantity`.
 * Returns null when the visible depth cannot fill the full quantity.
 */
export function fillFromDepth(levels: readonly DepthLevel[], quantity: number): Fill | null {
  if (quantity <= 0) return null;
  let remaining = quantity;
  let notional = 0;
  let levelsUsed = 0;
  for (const level of levels) {
    if (!(level.price > 0) || !(level.quantity > 0)) continue;
    const take = Math.min(remaining, level.quantity);
    notional += take * level.price;
    remaining -= take;
    levelsUsed++;
    if (remaining === 0) return { price: notional / quantity, quantity, levelsUsed };
  }
  return null;
}

export function totalDepthQuantity(levels: readonly DepthLevel[]): number {
  return levels.reduce((s, l) => s + (l.price > 0 && l.quantity > 0 ? l.quantity : 0), 0);
}

/** Bid-ask spread as a percentage of the mid price, or null if either side is missing. */
export function spreadPct(bids: readonly DepthLevel[], asks: readonly DepthLevel[]): number | null {
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  if (!(bid && bid > 0) || !(ask && ask > 0) || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}
