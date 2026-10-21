import { describe, expect, it } from 'vitest';
import { parseSnapQuote, SNAPQUOTE_LENGTH } from '../src/providers/angel/snapquote';
import { packetToQuote } from '../src/providers/angel/stream';
import { QuoteStore } from '../src/quoteStore';
import type { Quote } from '@arb/core';

function snapQuoteBuffer(): Buffer {
  const b = Buffer.alloc(SNAPQUOTE_LENGTH);
  b.writeUInt8(3, 0); // SnapQuote
  b.writeUInt8(2, 1); // NFO
  b.write('48987', 2, 'ascii');
  b.writeBigInt64LE(77n, 27); // sequence
  b.writeBigInt64LE(1_792_559_400_000n, 35); // exchange timestamp
  b.writeBigInt64LE(120_400n, 43); // LTP ₹1,204.00
  b.writeBigInt64LE(500n, 51);
  b.writeBigInt64LE(120_350n, 59); // avg ₹1,203.50
  b.writeBigInt64LE(1_000n, 67); // volume
  b.writeDoubleLE(5_000, 75);
  b.writeDoubleLE(6_000, 83);
  b.writeBigInt64LE(13_688_300n, 131); // OI
  const level = (i: number, flag: number, qty: bigint, paise: bigint, orders: number) => {
    const off = 147 + i * 20;
    b.writeInt16LE(flag, off);
    b.writeBigInt64LE(qty, off + 2);
    b.writeBigInt64LE(paise, off + 10);
    b.writeInt16LE(orders, off + 18);
  };
  level(0, 1, 500n, 120_400n, 2);
  level(1, 1, 1000n, 120_390n, 3);
  level(5, 0, 750n, 120_460n, 1);
  level(6, 0, 0n, 0n, 0); // empty level is dropped
  return b;
}

describe('SnapQuote parser', () => {
  it('decodes fields, scales paise and splits depth', () => {
    const p = parseSnapQuote(snapQuoteBuffer())!;
    expect(p.token).toBe('48987');
    expect(p.exchangeType).toBe(2);
    expect(p.ltp).toBe(1204);
    expect(p.avgPrice).toBe(1203.5);
    expect(p.openInterest).toBe(13_688_300);
    expect(p.bids).toEqual([
      { price: 1204, quantity: 500, orders: 2 },
      { price: 1203.9, quantity: 1000, orders: 3 },
    ]);
    expect(p.asks).toEqual([{ price: 1204.6, quantity: 750, orders: 1 }]);
  });

  it('ignores other modes and short packets', () => {
    const b = snapQuoteBuffer();
    b.writeUInt8(1, 0);
    expect(parseSnapQuote(b)).toBeNull();
    expect(parseSnapQuote(Buffer.alloc(50))).toBeNull();
  });

  it('maps to a live core quote with turnover and OI', () => {
    const q = packetToQuote(parseSnapQuote(snapQuoteBuffer())!, 999);
    expect(q).toMatchObject({ token: '48987', ltp: 1204, turnover: 1_203_500, openInterest: 13_688_300, dataKind: 'live', receivedAt: 999 });
  });
});

describe('QuoteStore freshness', () => {
  const q = (receivedAt: number): Quote => ({
    token: 'T', ltp: 1, bids: [], asks: [], volume: null, turnover: null, openInterest: null,
    exchangeTimestamp: null, receivedAt, tradable: true, dataKind: 'live',
  });

  it('a quiet instrument on a healthy feed is confirmed by the feed', () => {
    const s = new QuoteStore(300_000);
    s.upsert(q(1_000));
    expect(s.get('T', 61_000)!.receivedAt).toBe(61_000);
  });

  it('confirmation is capped by the quiet limit', () => {
    const s = new QuoteStore(300_000);
    s.upsert(q(1_000));
    expect(s.get('T', 900_000)!.receivedAt).toBe(301_000);
  });

  it('a dead feed does not refresh quotes', () => {
    const s = new QuoteStore(300_000);
    s.upsert(q(50_000));
    expect(s.get('T', 10_000)!.receivedAt).toBe(50_000);
    expect(s.get('missing', 10_000)).toBeUndefined();
  });
});
