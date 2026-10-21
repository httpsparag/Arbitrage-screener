// NSE session clock (IST). Exchange holidays are not known here; on a holiday the feed simply
// stays quiet and the dashboard reports "no ticks" rather than pretending the market traded.

import {
  CASH_CONTINUOUS_END_MINUTES,
  CLOSING_AUCTION_END_MINUTES,
  FO_CLOSE_MINUTES,
  istMinutes,
  MARKET_OPEN_MINUTES,
} from '@arb/core';

/**
 * - pre_open: 09:00–09:15 call auction
 * - open: 09:15–15:15 continuous trading on both legs (the only executable phase)
 * - closing_auction: 15:15–15:35 cash Closing Auction Session (books may be crossed)
 * - fo_only: 15:35–15:40 futures still trading, cash closed
 * - closed
 */
export type SessionPhase = 'pre_open' | 'open' | 'closing_auction' | 'fo_only' | 'closed';

/** Worker connects from this time (login, contract refresh, stream warm-up). */
export const WORKER_START_MINUTES = 8 * 60 + 45;
/** Worker disconnects after this time, once the final snapshot is out. */
export const WORKER_STOP_MINUTES = 15 * 60 + 50;

export function isWeekday(now: number): boolean {
  const day = new Date(now + 330 * 60_000).getUTCDay();
  return day >= 1 && day <= 5;
}

export function sessionPhase(now: number): SessionPhase {
  if (!isWeekday(now)) return 'closed';
  const m = istMinutes(now);
  if (m >= 9 * 60 && m < MARKET_OPEN_MINUTES) return 'pre_open';
  if (m >= MARKET_OPEN_MINUTES && m < CASH_CONTINUOUS_END_MINUTES) return 'open';
  if (m >= CASH_CONTINUOUS_END_MINUTES && m < CLOSING_AUCTION_END_MINUTES) return 'closing_auction';
  if (m >= CLOSING_AUCTION_END_MINUTES && m < FO_CLOSE_MINUTES) return 'fo_only';
  return 'closed';
}

/** Whether the worker should hold a live connection right now. */
export function shouldRun(now: number): boolean {
  if (!isWeekday(now)) return false;
  const m = istMinutes(now);
  return m >= WORKER_START_MINUTES && m < WORKER_STOP_MINUTES;
}
