// Latest quote per instrument, with a freshness rule suited to streaming feeds.
//
// A streaming feed only sends a packet when something changes, so a quiet instrument on a
// healthy connection is still current. A quote is therefore treated as confirmed up to the
// feed's last message, but never more than `quietLimitMs` after its own last update.
// If the connection dies, `lastMessageAt` stops advancing and every quote ages into staleness.

import type { Quote } from '@arb/core';

export class QuoteStore {
  private quotes = new Map<string, Quote>();

  constructor(private readonly quietLimitMs = 5 * 60_000) {}

  upsert(quote: Quote): void {
    this.quotes.set(quote.token, quote);
  }

  get size(): number {
    return this.quotes.size;
  }

  has(token: string): boolean {
    return this.quotes.has(token);
  }

  /** Quote with `receivedAt` set to the effective confirmation time. */
  get(token: string, feedLastMessageAt: number | null): Quote | undefined {
    const q = this.quotes.get(token);
    if (!q) return undefined;
    const confirmedAt = Math.max(
      q.receivedAt,
      Math.min(feedLastMessageAt ?? 0, q.receivedAt + this.quietLimitMs),
    );
    return confirmedAt === q.receivedAt ? q : { ...q, receivedAt: confirmedAt };
  }

  clear(): void {
    this.quotes.clear();
  }
}
