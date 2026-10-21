// Parser for Angel One WebSocket 2.0 binary packets (little-endian), per the official SDK.
// NSE prices arrive in paise.

import type { DepthLevel } from '@arb/core';

export const MODE = { LTP: 1, Quote: 2, SnapQuote: 3 } as const;
export const EXCHANGE_TYPE = { NSE: 1, NFO: 2 } as const;

export const SNAPQUOTE_LENGTH = 379;

export interface SnapQuotePacket {
  mode: number;
  exchangeType: number;
  token: string;
  sequence: bigint;
  exchangeTimestamp: number;
  ltp: number;
  lastTradedQty: number;
  avgPrice: number;
  volume: number;
  totalBuyQty: number;
  totalSellQty: number;
  open: number;
  high: number;
  low: number;
  close: number;
  lastTradedTimestamp: number;
  openInterest: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  upperCircuit: number;
  lowerCircuit: number;
}

const PAISE = 100;

function readToken(buf: Buffer): string {
  const raw = buf.subarray(2, 27);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('ascii');
}

const i64 = (buf: Buffer, off: number) => Number(buf.readBigInt64LE(off));

/** Parses a SnapQuote (mode 3) packet; returns null for other modes or short buffers. */
export function parseSnapQuote(buf: Buffer): SnapQuotePacket | null {
  if (buf.length < SNAPQUOTE_LENGTH || buf.readUInt8(0) !== MODE.SnapQuote) return null;
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (let i = 0; i < 10; i++) {
    const off = 147 + i * 20;
    const flag = buf.readInt16LE(off);
    const quantity = i64(buf, off + 2);
    const price = i64(buf, off + 10) / PAISE;
    const orders = buf.readInt16LE(off + 18);
    if (!(price > 0) || !(quantity > 0)) continue;
    // flag 1 = buy; first five entries are bids, last five asks.
    const isBid = flag === 1 || (flag !== 0 && i < 5);
    (isBid ? bids : asks).push({ price, quantity, orders });
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return {
    mode: buf.readUInt8(0),
    exchangeType: buf.readUInt8(1),
    token: readToken(buf),
    sequence: buf.readBigInt64LE(27),
    exchangeTimestamp: i64(buf, 35),
    ltp: i64(buf, 43) / PAISE,
    lastTradedQty: i64(buf, 51),
    avgPrice: i64(buf, 59) / PAISE,
    volume: i64(buf, 67),
    totalBuyQty: buf.readDoubleLE(75),
    totalSellQty: buf.readDoubleLE(83),
    open: i64(buf, 91) / PAISE,
    high: i64(buf, 99) / PAISE,
    low: i64(buf, 107) / PAISE,
    close: i64(buf, 115) / PAISE,
    lastTradedTimestamp: i64(buf, 123),
    openInterest: i64(buf, 131),
    bids,
    asks,
    upperCircuit: i64(buf, 347) / PAISE,
    lowerCircuit: i64(buf, 355) / PAISE,
  };
}
