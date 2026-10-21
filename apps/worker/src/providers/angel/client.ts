// Minimal Angel One SmartAPI REST client (login, market quotes, logout).
// Endpoints and headers follow the official smartapi-javascript SDK.

import type { AngelConfig } from '../../config';
import { totp } from './totp';

const ROOT = 'https://apiconnect.angelone.in';
const ROUTES = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  logout: '/rest/secure/angelbroking/user/v1/logout',
  quote: '/rest/secure/angelbroking/market/v1/quote',
} as const;

/** Max tokens per quote request. */
export const QUOTE_BATCH_SIZE = 50;
/** Conservative spacing between quote requests. */
const QUOTE_MIN_INTERVAL_MS = 1100;

export type AngelExchange = 'NSE' | 'NFO';
export type QuoteMode = 'LTP' | 'OHLC' | 'FULL';

export interface AngelDepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

/** One instrument from the FULL-mode quote response. */
export interface AngelFullQuote {
  exchange: string;
  tradingSymbol: string;
  symbolToken: string;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  avgPrice?: number;
  tradeVolume?: number;
  opnInterest?: number;
  exchFeedTime?: string;
  exchTradeTime?: string;
  lowerCircuit?: number;
  upperCircuit?: number;
  depth?: { buy?: AngelDepthLevel[]; sell?: AngelDepthLevel[] };
  [key: string]: unknown;
}

export interface Session {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  loggedInAt: number;
}

export class AngelApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: string | null,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  status: boolean;
  message: string;
  errorcode: string;
  data: T;
}

async function detectPublicIp(): Promise<string> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    if (res.ok) return (await res.text()).trim();
  } catch {
    // fall through
  }
  return '127.0.0.1';
}

export class AngelClient {
  private session: Session | null = null;
  private publicIp: string | null;
  private lastQuoteAt = 0;

  constructor(private readonly cfg: AngelConfig) {
    this.publicIp = cfg.publicIp;
  }

  get isLoggedIn(): boolean {
    return this.session !== null;
  }

  get currentSession(): Session | null {
    return this.session;
  }

  private async headers(): Promise<Record<string, string>> {
    this.publicIp ??= await detectPublicIp();
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': this.publicIp,
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.cfg.apiKey,
    };
    if (this.session) h.Authorization = `Bearer ${this.session.jwtToken}`;
    return h;
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const res = await fetch(ROOT + route, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Envelope<T>;
    try {
      json = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new AngelApiError(
        `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        null,
        res.status,
      );
    }
    if (!res.ok || !json.status) {
      throw new AngelApiError(json.message || `HTTP ${res.status}`, json.errorcode || null, res.status);
    }
    return json.data;
  }

  async login(): Promise<Session> {
    const data = await this.post<{ jwtToken: string; refreshToken: string; feedToken: string }>(
      ROUTES.login,
      { clientcode: this.cfg.clientCode, password: this.cfg.pin, totp: totp(this.cfg.totpSecret) },
    );
    if (!data?.jwtToken || !data.feedToken) {
      throw new AngelApiError('Login response did not include session tokens', null, 200);
    }
    this.session = {
      jwtToken: data.jwtToken,
      refreshToken: data.refreshToken,
      feedToken: data.feedToken,
      loggedInAt: Date.now(),
    };
    return this.session;
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    try {
      await this.post(ROUTES.logout, { clientcode: this.cfg.clientCode });
    } finally {
      this.session = null;
    }
  }

  /**
   * Fetches quotes for any number of tokens, batching and spacing requests
   * to stay inside the provider's limits.
   */
  async quotes(
    tokens: Partial<Record<AngelExchange, string[]>>,
    mode: QuoteMode = 'FULL',
  ): Promise<{ fetched: AngelFullQuote[]; unfetched: unknown[] }> {
    if (!this.session) throw new Error('Not logged in');
    const all = (Object.entries(tokens) as [AngelExchange, string[]][]).flatMap(([ex, list]) =>
      list.map((t) => [ex, t] as const),
    );
    const fetched: AngelFullQuote[] = [];
    const unfetched: unknown[] = [];
    for (let i = 0; i < all.length; i += QUOTE_BATCH_SIZE) {
      const batch: Partial<Record<AngelExchange, string[]>> = {};
      for (const [ex, t] of all.slice(i, i + QUOTE_BATCH_SIZE)) (batch[ex] ??= []).push(t);
      const wait = this.lastQuoteAt + QUOTE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastQuoteAt = Date.now();
      const data = await this.post<{ fetched?: AngelFullQuote[]; unfetched?: unknown[] }>(ROUTES.quote, {
        mode,
        exchangeTokens: batch,
      });
      fetched.push(...(data?.fetched ?? []));
      unfetched.push(...(data?.unfetched ?? []));
    }
    return { fetched, unfetched };
  }
}
