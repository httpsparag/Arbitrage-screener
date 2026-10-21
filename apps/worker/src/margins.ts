// Broker margins for the short futures leg, from Angel One's margin calculator.
// Stored as a rate (margin ÷ futures value) so it scales with price and lot count during the day.
// Cached on disk per trading day so restarts don't re-fetch all contracts.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { istDate, type Contract } from '@arb/core';
import { AngelApiError, type AngelClient } from './providers/angel/client';

const SPACING_MS = 350;

interface CacheFile {
  date: string;
  fetchedAt: number;
  rates: Record<string, number>;
}

export class MarginBook {
  private rates = new Map<string, number>();
  private fetchedAt: number | null = null;
  private date = '';

  constructor(private readonly cachePath: string) {}

  rate(futToken: string): number | null {
    return this.rates.get(futToken) ?? null;
  }

  get size(): number {
    return this.rates.size;
  }

  get lastFetchedAt(): number | null {
    return this.fetchedAt;
  }

  /** Loads today's cached margins, if any. */
  async loadCache(now = Date.now()): Promise<boolean> {
    try {
      const c = JSON.parse(await readFile(this.cachePath, 'utf8')) as CacheFile;
      if (c.date !== istDate(now)) return false;
      this.rates = new Map(Object.entries(c.rates));
      this.fetchedAt = c.fetchedAt;
      this.date = c.date;
      return this.rates.size > 0;
    } catch {
      return false;
    }
  }

  private async saveCache(): Promise<void> {
    const body: CacheFile = { date: this.date, fetchedAt: this.fetchedAt ?? Date.now(), rates: Object.fromEntries(this.rates) };
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(body));
  }

  /**
   * Fetches the 1-lot short-futures margin for each contract. `futPrice` supplies the price used
   * to convert the rupee margin into a rate; contracts without a price are skipped.
   */
  async refresh(
    client: AngelClient,
    contracts: readonly Contract[],
    futPrice: (futToken: string) => number | null,
    shouldStop: () => boolean = () => false,
  ): Promise<{ updated: number; failed: number; skipped: number }> {
    let updated = 0;
    let failed = 0;
    let skipped = 0;
    for (const c of contracts) {
      if (shouldStop()) break;
      const price = futPrice(c.futToken);
      if (!price || price <= 0) {
        skipped++;
        continue;
      }
      const ask = () =>
        client.margin([
          { exchange: 'NFO', qty: c.lotSize, price: 0, productType: 'CARRYFORWARD', token: c.futToken, tradeType: 'SELL', orderType: 'MARKET' },
        ]);
      try {
        let res: Record<string, unknown>;
        try {
          res = await ask();
        } catch (err) {
          // One retry after a pause, e.g. when the rate limit is hit.
          if (!(err instanceof AngelApiError)) throw err;
          await new Promise((r) => setTimeout(r, 3000));
          res = await ask();
        }
        const margin = Number(res.totalMarginRequired);
        const rate = margin / (price * c.lotSize);
        if (Number.isFinite(rate) && rate > 0 && rate < 1) {
          this.rates.set(c.futToken, rate);
          updated++;
        } else failed++;
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, SPACING_MS));
    }
    if (updated > 0) {
      this.fetchedAt = Date.now();
      this.date = istDate(this.fetchedAt);
      await this.saveCache().catch(() => undefined);
    }
    return { updated, failed, skipped };
  }
}
