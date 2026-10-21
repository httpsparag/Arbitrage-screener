// Provider-neutral market-data interface. The calculation engine only ever sees core `Quote`s,
// so a different broker or feed can be swapped in by implementing this interface.

import type { DataKind, Quote } from '@arb/core';

export type Exchange = 'NSE' | 'NFO';

export interface Instrument {
  token: string;
  exchange: Exchange;
}

export type FeedState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'error';

export interface ProviderStatus {
  provider: string;
  dataKind: DataKind;
  state: FeedState;
  /** Last message of any kind (tick or heartbeat reply), ms epoch. */
  lastMessageAt: number | null;
  /** Last market-data tick, ms epoch. */
  lastTickAt: number | null;
  subscribed: number;
  reconnects: number;
  lastError: string | null;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly dataKind: DataKind;
  start(instruments: readonly Instrument[]): Promise<void>;
  stop(): Promise<void>;
  status(): ProviderStatus;
  onQuote(listener: (quote: Quote) => void): void;
  onStatus(listener: (status: ProviderStatus) => void): void;
}
