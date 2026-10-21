import { describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../src/providers/angel/totp';
import { buildUniverse, parseExpiry, type ScripRow } from '../src/providers/angel/scripMaster';
import { parseAngelTime, toCoreQuote } from '../src/providers/angel/quotes';
import { mask } from '../src/config';

// RFC 6238 test secret: ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it('decodes base32', () => {
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });

  it('matches RFC 6238 SHA1 vectors (last 6 digits)', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000)).toBe('005924');
  });

  it('rejects invalid secrets', () => {
    expect(() => totp('not-base32!')).toThrow();
  });
});

const row = (over: Partial<ScripRow>): ScripRow => ({
  token: '1',
  symbol: 'X',
  name: 'X',
  expiry: '',
  strike: '-1.000000',
  lotsize: '1',
  instrumenttype: '',
  exch_seg: 'NSE',
  tick_size: '10.000000',
  ...over,
});

describe('universe', () => {
  const NOW = Date.parse('2026-10-21T04:30:00Z'); // 10:00 IST
  const rows: ScripRow[] = [
    row({ token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE' }),
    row({ token: '100', symbol: 'RELIANCE27OCT26FUT', name: 'RELIANCE', expiry: '27OCT2026', lotsize: '500', instrumenttype: 'FUTSTK', exch_seg: 'NFO' }),
    row({ token: '101', symbol: 'RELIANCE29DEC26FUT', name: 'RELIANCE', expiry: '29DEC2026', lotsize: '500', instrumenttype: 'FUTSTK', exch_seg: 'NFO' }),
    row({ token: '102', symbol: 'RELIANCE29SEP26FUT', name: 'RELIANCE', expiry: '29SEP2026', lotsize: '500', instrumenttype: 'FUTSTK', exch_seg: 'NFO' }),
    row({ token: '200', symbol: '141NSETEST27NOV36FUT', name: '141NSETEST', expiry: '27NOV2036', lotsize: '50', instrumenttype: 'FUTSTK', exch_seg: 'NFO' }),
    row({ token: '300', symbol: 'NOCASH27OCT26FUT', name: 'NOCASH', expiry: '27OCT2026', lotsize: '100', instrumenttype: 'FUTSTK', exch_seg: 'NFO' }),
    row({ token: '400', symbol: 'NIFTY27OCT26FUT', name: 'NIFTY', expiry: '27OCT2026', lotsize: '75', instrumenttype: 'FUTIDX', exch_seg: 'NFO' }),
  ];

  it('pairs each stock future with its cash instrument and current expiry', () => {
    const u = buildUniverse(rows, NOW);
    expect(u.contracts.map((c) => c.futTradingSymbol)).toEqual(['RELIANCE27OCT26FUT', 'RELIANCE29DEC26FUT']);
    expect(u.contracts[0]).toMatchObject({ cashToken: '2885', futToken: '100', expiry: '2026-10-27', lotSize: 500, tickSize: 0.1 });
  });

  it('records why rows were skipped', () => {
    const reasons = Object.fromEntries(buildUniverse(rows, NOW).skipped.map((s) => [s.row.symbol, s.reason]));
    expect(reasons['RELIANCE29SEP26FUT']).toBe('expired');
    expect(reasons['141NSETEST27NOV36FUT']).toMatch(/test/);
    expect(reasons['NOCASH27OCT26FUT']).toMatch(/no matching/);
    expect(reasons['NIFTY27OCT26FUT']).toBeUndefined(); // index futures are not considered at all
  });

  it('parses expiry codes', () => {
    expect(parseExpiry('23NOV2026')).toBe('2026-11-23');
    expect(parseExpiry('')).toBeNull();
    expect(parseExpiry('31XYZ2026')).toBeNull();
  });
});

describe('quote mapping', () => {
  it('parses IST feed time', () => {
    expect(parseAngelTime('21-Oct-2026 10:00:00')).toBe(Date.parse('2026-10-21T04:30:00Z'));
    expect(parseAngelTime('garbage')).toBeNull();
  });

  it('maps depth, turnover and OI; drops empty depth levels', () => {
    const q = toCoreQuote(
      {
        exchange: 'NFO',
        tradingSymbol: 'RELIANCE27OCT26FUT',
        symbolToken: '100',
        ltp: 1410.5,
        avgPrice: 1400,
        tradeVolume: 1000,
        opnInterest: 5000,
        exchFeedTime: '21-Oct-2026 10:00:00',
        depth: {
          buy: [{ price: 1410, quantity: 500, orders: 2 }, { price: 0, quantity: 0, orders: 0 }],
          sell: [{ price: 1410.6, quantity: 1000, orders: 3 }],
        },
      },
      123,
      'snapshot',
    );
    expect(q.bids).toEqual([{ price: 1410, quantity: 500, orders: 2 }]);
    expect(q.asks[0]!.price).toBe(1410.6);
    expect(q.turnover).toBe(1_400_000);
    expect(q.openInterest).toBe(5000);
    expect(q.receivedAt).toBe(123);
    expect(q.dataKind).toBe('snapshot');
  });
});

describe('mask', () => {
  it('never reveals the middle of a secret', () => {
    expect(mask('A123456')).toBe('A1****56');
    expect(mask('abc')).toBe('****');
  });
});
