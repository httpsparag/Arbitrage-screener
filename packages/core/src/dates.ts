// IST date helpers. NSE runs on IST (UTC+5:30, no DST).

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

// NSE session times, minutes after IST midnight. Since 3 Aug 2026, F&O stocks' cash leg ends
// continuous trading at 15:15 and closes via a Closing Auction Session (15:15–15:35);
// equity derivatives trade until 15:40.
export const MARKET_OPEN_MINUTES = 9 * 60 + 15;
/** End of continuous trading in the cash segment for F&O stocks. */
export const CASH_CONTINUOUS_END_MINUTES = 15 * 60 + 15;
/** End of the cash-segment Closing Auction Session. */
export const CLOSING_AUCTION_END_MINUTES = 15 * 60 + 35;
/** Close of equity derivatives trading. */
export const FO_CLOSE_MINUTES = 15 * 60 + 40;
/** @deprecated Use CASH_CONTINUOUS_END_MINUTES or FO_CLOSE_MINUTES. */
export const MARKET_CLOSE_MINUTES = CASH_CONTINUOUS_END_MINUTES;

/** Calendar date in IST for an epoch-ms instant, as YYYY-MM-DD. */
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since IST midnight. */
export function istMinutes(ms: number): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** A futures contract stops being tradable after the derivatives close on its expiry day. */
export function isExpired(expiry: string, now: number): boolean {
  const today = istDate(now);
  if (expiry < today) return true;
  return expiry === today && istMinutes(now) >= FO_CLOSE_MINUTES;
}
