import { DEFAULT_CALC_CONFIG, type CalcConfig } from '../src/engine';
import type { Contract, DepthLevel, Quote } from '../src/types';

/** 2026-10-20 10:00 IST. */
export const NOW = Date.parse('2026-10-20T04:30:00Z');

export function contract(over: Partial<Contract> = {}): Contract {
  return {
    symbol: 'XYZ',
    name: 'XYZ Industries Ltd',
    cashToken: 'C1',
    cashTradingSymbol: 'XYZ-EQ',
    futToken: 'F1',
    futTradingSymbol: 'XYZ26NOVFUT',
    expiry: '2026-11-19', // 30 calendar days after NOW
    lotSize: 500,
    tickSize: 0.05,
    status: 'active',
    ...over,
  };
}

export function quote(token: string, over: Partial<Quote> & { bid?: number; ask?: number } = {}): Quote {
  const { bid, ask, ...rest } = over;
  const lvl = (price: number): DepthLevel[] => [{ price, quantity: 2000 }];
  return {
    token,
    ltp: ask ?? 1000,
    bids: bid !== undefined ? lvl(bid) : [],
    asks: ask !== undefined ? lvl(ask) : [],
    volume: 1_000_000,
    turnover: 1e9,
    openInterest: token.startsWith('F') ? 5_000_000 : null,
    exchangeTimestamp: NOW - 1000,
    receivedAt: NOW - 1000,
    tradable: true,
    dataKind: 'live',
    ...rest,
  };
}

/** Cash ask 1000, futures bid 1010: the hand-worked example. */
export function pair() {
  return {
    cashQuote: quote('C1', { bid: 999.9, ask: 1000, ltp: 1000 }),
    futQuote: quote('F1', { bid: 1010, ask: 1010.2, ltp: 1010.1 }),
  };
}

export function config(over: Partial<CalcConfig> = {}): CalcConfig {
  return { ...DEFAULT_CALC_CONFIG, ...over };
}
