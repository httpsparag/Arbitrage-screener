// Converts Angel One quote payloads into the engine's provider-neutral Quote.

import type { DataKind, DepthLevel, Quote } from '@arb/core';
import type { AngelDepthLevel, AngelFullQuote } from './client';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "21-Jun-2023 13:47:51" (IST) -> epoch ms; null if unparseable. */
export function parseAngelTime(raw: string | undefined): number | null {
  const m = raw && /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2]![0]!.toUpperCase() + m[2]!.slice(1).toLowerCase()];
  if (month === undefined) return null;
  const utc = Date.UTC(+m[3]!, month, +m[1]!, +m[4]!, +m[5]!, +m[6]!);
  return utc - 330 * 60 * 1000;
}

function levels(raw: AngelDepthLevel[] | undefined): DepthLevel[] {
  return (raw ?? [])
    .filter((l) => Number(l.price) > 0 && Number(l.quantity) > 0)
    .map((l) => ({ price: Number(l.price), quantity: Number(l.quantity), orders: Number(l.orders) || 0 }));
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toCoreQuote(raw: AngelFullQuote, receivedAt: number, dataKind: DataKind): Quote {
  const volume = num(raw.tradeVolume);
  const avg = num(raw.avgPrice);
  const oi = num(raw.opnInterest);
  return {
    token: String(raw.symbolToken),
    ltp: num(raw.ltp) && num(raw.ltp)! > 0 ? num(raw.ltp) : null,
    bids: levels(raw.depth?.buy),
    asks: levels(raw.depth?.sell),
    volume,
    turnover: volume !== null && avg !== null && avg > 0 ? volume * avg : null,
    openInterest: raw.exchange === 'NFO' && oi !== null ? oi : null,
    exchangeTimestamp: parseAngelTime(raw.exchFeedTime),
    receivedAt,
    tradable: true,
    dataKind,
  };
}
