// Angel One WebSocket 2.0 live feed (SnapQuote mode: LTP, volume, OI and best-5 depth).
// Reconnects with exponential backoff and re-logs-in when the session is rejected.

import WebSocket from 'ws';
import type { Quote } from '@arb/core';
import type { AngelConfig } from '../../config';
import type { Instrument, MarketDataProvider, ProviderStatus } from '../Provider';
import type { AngelClient } from './client';
import { EXCHANGE_TYPE, MODE, parseSnapQuote, type SnapQuotePacket } from './snapquote';

const URL = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_MS = 10_000;
/** Reconnect if nothing (not even a heartbeat reply) arrives for this long. */
const WATCHDOG_MS = 25_000;
/** Per-connection subscription limit documented by Angel One. */
export const MAX_TOKENS_PER_CONNECTION = 1000;
const SUBSCRIBE_CHUNK = 250;
const MAX_BACKOFF_MS = 60_000;

export function packetToQuote(p: SnapQuotePacket, receivedAt: number): Quote {
  const isFo = p.exchangeType === EXCHANGE_TYPE.NFO;
  return {
    token: p.token,
    ltp: p.ltp > 0 ? p.ltp : null,
    bids: p.bids,
    asks: p.asks,
    volume: p.volume,
    turnover: p.avgPrice > 0 ? p.avgPrice * p.volume : null,
    openInterest: isFo ? p.openInterest : null,
    exchangeTimestamp: p.exchangeTimestamp > 0 ? p.exchangeTimestamp : null,
    receivedAt,
    tradable: true,
    dataKind: 'live',
  };
}

export class AngelStreamProvider implements MarketDataProvider {
  readonly name = 'Angel One SmartAPI (WebSocket 2.0)';
  readonly dataKind = 'live' as const;

  private ws: WebSocket | null = null;
  private instruments: Instrument[] = [];
  private stopped = true;
  private needsRelogin = false;
  private attempt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private quoteListeners: ((q: Quote) => void)[] = [];
  private statusListeners: ((s: ProviderStatus) => void)[] = [];
  private st: ProviderStatus = {
    provider: this.name,
    dataKind: 'live',
    state: 'idle',
    lastMessageAt: null,
    lastTickAt: null,
    subscribed: 0,
    reconnects: 0,
    lastError: null,
  };
  /** Ticks received since start; useful for diagnostics. */
  ticks = 0;

  constructor(
    private readonly client: AngelClient,
    private readonly cfg: AngelConfig,
  ) {}

  status(): ProviderStatus {
    return { ...this.st };
  }

  onQuote(listener: (q: Quote) => void): void {
    this.quoteListeners.push(listener);
  }

  onStatus(listener: (s: ProviderStatus) => void): void {
    this.statusListeners.push(listener);
  }

  async start(instruments: readonly Instrument[]): Promise<void> {
    if (instruments.length > MAX_TOKENS_PER_CONNECTION) {
      throw new Error(
        `${instruments.length} instruments exceed the ${MAX_TOKENS_PER_CONNECTION}-token limit of one connection`,
      );
    }
    this.instruments = [...instruments];
    this.stopped = false;
    if (!this.client.isLoggedIn) await this.client.login();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.setStatus({ state: 'stopped' });
  }

  private setStatus(patch: Partial<ProviderStatus>) {
    this.st = { ...this.st, ...patch };
    for (const l of this.statusListeners) l(this.status());
  }

  private clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearInterval(this.watchdog);
    this.heartbeat = this.watchdog = null;
  }

  private connect() {
    const session = this.client.currentSession;
    if (!session) {
      this.needsRelogin = true;
      this.scheduleReconnect('No session');
      return;
    }
    this.setStatus({ state: this.attempt === 0 ? 'connecting' : 'reconnecting' });
    const ws = new WebSocket(URL, {
      headers: {
        Authorization: `Bearer ${session.jwtToken}`,
        'x-api-key': this.cfg.apiKey,
        'x-client-code': this.cfg.clientCode,
        'x-feed-token': session.feedToken,
      },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.st.lastMessageAt = Date.now();
      this.setStatus({ state: 'connected', lastError: null });
      this.subscribe(ws);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, HEARTBEAT_MS);
      this.watchdog = setInterval(() => {
        const last = this.st.lastMessageAt ?? 0;
        if (Date.now() - last > WATCHDOG_MS) ws.terminate();
      }, 5_000);
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      this.st.lastMessageAt = now;
      if (!isBinary) {
        const text = data.toString();
        if (text !== 'pong') this.setStatus({ lastError: `Server message: ${text.slice(0, 200)}` });
        return;
      }
      const packet = parseSnapQuote(data as Buffer);
      if (!packet) return;
      this.ticks++;
      this.st.lastTickAt = now;
      const quote = packetToQuote(packet, now);
      for (const l of this.quoteListeners) l(quote);
    });

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) this.needsRelogin = true;
      this.setStatus({ lastError: `WebSocket handshake rejected (HTTP ${res.statusCode})` });
      ws.terminate();
    });

    ws.on('error', (err) => this.setStatus({ lastError: err.message }));

    ws.on('close', () => {
      this.clearTimers();
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect(this.st.lastError ?? 'Connection closed');
    });
  }

  private subscribe(ws: WebSocket) {
    const byExchange: Record<number, string[]> = {};
    for (const i of this.instruments) (byExchange[EXCHANGE_TYPE[i.exchange]] ??= []).push(i.token);
    let n = 0;
    for (const [exchangeType, tokens] of Object.entries(byExchange)) {
      for (let i = 0; i < tokens.length; i += SUBSCRIBE_CHUNK) {
        ws.send(
          JSON.stringify({
            correlationID: `sub${++n}`,
            action: 1,
            params: {
              mode: MODE.SnapQuote,
              tokenList: [{ exchangeType: Number(exchangeType), tokens: tokens.slice(i, i + SUBSCRIBE_CHUNK) }],
            },
          }),
        );
      }
    }
    this.setStatus({ subscribed: this.instruments.length });
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt++;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt - 1, 6)) + Math.random() * 500;
    this.setStatus({ state: 'reconnecting', reconnects: this.st.reconnects + 1, lastError: reason });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (this.needsRelogin) {
        try {
          await this.client.login();
          this.needsRelogin = false;
        } catch (err) {
          this.scheduleReconnect(`Re-login failed: ${(err as Error).message}`);
          return;
        }
      }
      this.connect();
    }, delay);
  }
}
