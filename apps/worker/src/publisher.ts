// Writes worker output to Supabase: contracts, feed health, snapshots, basis history,
// and the private realtime broadcast the dashboard listens to.
// Uses the service-role key, which must only ever live in the worker's .env.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Contract, WireMessage } from '@arb/core';
import type { ProviderStatus } from './providers/Provider';

export const BROADCAST_TOPIC = 'screener';

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = env.SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in apps/worker/.env');
  }
  const kind = supabaseKeyKind(serviceKey);
  if (kind !== 'secret' && kind !== 'service_role') {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY holds a ${kind} key. The worker needs the secret key ` +
        '(Project Settings → API Keys → "Secret keys", sb_secret_…, or the legacy service_role key).',
    );
  }
  return { url: url.replace(/\/+$/, ''), serviceKey };
}

/** Classifies a Supabase API key without revealing it. */
export function supabaseKeyKind(key: string): 'secret' | 'publishable' | 'service_role' | 'anon' | 'unknown' {
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()).role;
      if (role === 'service_role' || role === 'anon') return role;
    } catch {
      // fall through
    }
  }
  return 'unknown';
}

export interface BasisSample {
  futToken: string;
  symbol: string;
  expiry: string;
  cashPrice: number;
  futPrice: number;
  basisPct: number;
}

export class Publisher {
  readonly db: SupabaseClient;

  constructor(private readonly cfg: SupabaseConfig) {
    this.db = createClient(cfg.url, cfg.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private async check<T>(label: string, p: PromiseLike<{ error: { message: string } | null; data?: T }>) {
    const { error, data } = await p;
    if (error) throw new Error(`${label}: ${error.message}`);
    return data;
  }

  async upsertContracts(contracts: readonly Contract[]): Promise<void> {
    const rows = contracts.map((c) => ({
      fut_token: c.futToken,
      symbol: c.symbol,
      name: c.name,
      cash_token: c.cashToken,
      cash_trading_symbol: c.cashTradingSymbol,
      fut_trading_symbol: c.futTradingSymbol,
      expiry: c.expiry,
      lot_size: c.lotSize,
      tick_size: c.tickSize,
      status: c.status,
      updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await this.check('contracts upsert', this.db.from('contracts').upsert(rows.slice(i, i + 500)));
    }
  }

  async writeFeedStatus(s: ProviderStatus, version: string): Promise<void> {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    await this.check(
      'feed_status upsert',
      this.db.from('feed_status').upsert({
        id: 1,
        provider: s.provider,
        data_kind: s.dataKind,
        state: s.state,
        last_message_at: iso(s.lastMessageAt),
        last_tick_at: iso(s.lastTickAt),
        subscribed: s.subscribed,
        reconnects: s.reconnects,
        last_error: s.lastError,
        heartbeat_at: new Date().toISOString(),
        worker_version: version,
      }),
    );
  }

  async writeSnapshot(message: WireMessage): Promise<void> {
    await this.check(
      'snapshot upsert',
      this.db.from('screener_snapshot').upsert({ id: 1, taken_at: new Date(message.at).toISOString(), payload: message }),
    );
  }

  /**
   * Sends one message on the private broadcast channel via Realtime's REST endpoint.
   * Returns the request body size in bytes.
   */
  async broadcast(event: string, payload: unknown): Promise<number> {
    const body = JSON.stringify({ messages: [{ topic: BROADCAST_TOPIC, event, payload, private: true }] });
    const res = await fetch(`${this.cfg.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: this.cfg.serviceKey,
        Authorization: `Bearer ${this.cfg.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`broadcast ${event}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return Buffer.byteLength(body);
  }

  async insertBasisSamples(ts: number, samples: readonly BasisSample[]): Promise<void> {
    if (!samples.length) return;
    const at = new Date(ts).toISOString();
    await this.check(
      'basis_history insert',
      this.db.from('basis_history').upsert(
        samples.map((s) => ({
          fut_token: s.futToken,
          ts: at,
          cash_price: s.cashPrice,
          fut_price: s.futPrice,
          basis_pct: s.basisPct,
        })),
      ),
    );
  }

  async upsertBasisDaily(
    tradeDate: string,
    rows: readonly { futToken: string; symbol: string; expiry: string; close: number; avg: number; min: number; max: number; samples: number }[],
  ): Promise<void> {
    if (!rows.length) return;
    await this.check(
      'basis_daily upsert',
      this.db.from('basis_daily').upsert(
        rows.map((r) => ({
          fut_token: r.futToken,
          trade_date: tradeDate,
          symbol: r.symbol,
          expiry: r.expiry,
          close_basis_pct: r.close,
          avg_basis_pct: r.avg,
          min_basis_pct: r.min,
          max_basis_pct: r.max,
          samples: r.samples,
        })),
      ),
    );
  }

  async pruneBasisHistory(olderThan: number): Promise<void> {
    await this.check(
      'basis_history prune',
      this.db.from('basis_history').delete().lt('ts', new Date(olderThan).toISOString()),
    );
  }

  async writeSessionSummary(tradeDate: string, summary: unknown): Promise<void> {
    await this.check(
      'session summary',
      this.db.from('session_summaries').upsert({ trade_date: tradeDate, summary }),
    );
  }

  /** Calculation settings of the (single) dashboard user, if saved. */
  async readUserSettings(): Promise<Record<string, unknown> | null> {
    const data = await this.check(
      'user_settings read',
      this.db.from('user_settings').select('calc_config').order('updated_at', { ascending: false }).limit(1),
    );
    const row = (data as { calc_config: Record<string, unknown> }[] | undefined)?.[0];
    return row?.calc_config ?? null;
  }
}
