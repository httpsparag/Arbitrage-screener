// The screener service: keeps the live feed connected during market hours, recalculates
// opportunities as quotes change, and publishes results for the dashboard.

import { join } from 'node:path';
import {
  applySettings,
  computeOpportunity,
  DEFAULT_CALC_CONFIG,
  istDate,
  metricValue,
  rankOpportunities,
  summarize,
  toWireRow,
  withTopQuantities,
  type CalcConfig,
  type Contract,
  type Opportunity,
  type Quote,
  type WireFeed,
  type WireMessage,
  type WireSummary,
} from '@arb/core';
import type { AngelConfig } from './config';
import { AngelClient } from './providers/angel/client';
import { buildUniverse, loadScripMaster } from './providers/angel/scripMaster';
import { AngelStreamProvider } from './providers/angel/stream';
import type { Instrument, ProviderStatus } from './providers/Provider';
import { buildCloseMessage } from './closeSnapshot';
import { MarginBook } from './margins';
import { Publisher, type BasisSample } from './publisher';
import { QuoteStore } from './quoteStore';
import { sessionPhase, shouldRun } from './session';

export const WORKER_VERSION = '0.1.0';

const SCHEDULER_MS = 15_000;
const RECALC_DIRTY_MS = 1_000;
const PUBLISH_TOP_MS = 5_000;
const PUBLISH_FULL_MS = 60_000;
const STATUS_MS = 15_000;
const SETTINGS_MS = 60_000;
const BASIS_SAMPLE_MS = 5 * 60_000;
const TOP_ROWS = 100;
const HISTORY_RETENTION_MS = 8 * 86_400_000;
/** Broker margins change with exchange risk parameters; refresh a few times a day. */
const MARGIN_REFRESH_MS = 2 * 60 * 60_000;
const MARGIN_FIRST_FETCH_DELAY_MS = 20_000;

export interface ServiceOptions {
  /** Hold the feed open regardless of the clock (testing). Rows are still marked closed outside the session. */
  forceRun?: boolean;
  dataDir?: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface BasisAccumulator {
  symbol: string;
  expiry: string;
  sum: number;
  n: number;
  min: number;
  max: number;
  last: number;
}

const defaultLog: NonNullable<ServiceOptions['log']> = (level, msg) => {
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`${t} ${level.toUpperCase().padEnd(5)} ${msg}`);
};

export class ScreenerService {
  private readonly client: AngelClient;
  private readonly log: NonNullable<ServiceOptions['log']>;
  private feed: AngelStreamProvider | null = null;
  private store = new QuoteStore();
  private margins: MarginBook;
  private marginsBusy = false;
  private contracts: Contract[] = [];
  private contractsByToken = new Map<string, Contract[]>();
  private opps = new Map<string, Opportunity>();
  private dirty = new Set<string>();
  private config: CalcConfig = DEFAULT_CALC_CONFIG;
  private settingsRaw: Record<string, unknown> = {};
  private running = false;
  private starting = false;
  private tradeDate = '';
  private basis = new Map<string, BasisAccumulator>();
  private timers: NodeJS.Timeout[] = [];
  private scheduler: NodeJS.Timeout | null = null;
  private idleStatusAt = 0;
  /** Earliest time to retry a failed start, and the current backoff. */
  private nextStartAt = 0;
  private startBackoffMs = 60_000;
  /** Last broadcast error, so repeated identical failures are logged once. */
  private broadcastError: string | null = null;
  private loggedTopSize = false;
  private lastPhase: string | null = null;
  /** Trade date whose end-of-continuous-session summary has been written. */
  private summaryWrittenFor = '';
  /** Trade date whose closing-prices snapshot has been written. */
  private closeWrittenFor = '';

  constructor(
    private readonly angel: AngelConfig,
    private readonly publisher: Publisher,
    private readonly opts: ServiceOptions = {},
  ) {
    this.client = new AngelClient(angel);
    this.log = opts.log ?? defaultLog;
    this.margins = new MarginBook(join(opts.dataDir ?? join(process.cwd(), 'data'), 'margins.json'));
  }

  async start(): Promise<void> {
    await this.refreshSettings();
    await this.schedule();
    this.scheduler = setInterval(() => void this.schedule(), SCHEDULER_MS);
  }

  async shutdown(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    if (this.running) await this.stopFeed('shutdown');
    await this.publisher
      .writeFeedStatus(this.idleStatus('stopped', 'Worker stopped'), WORKER_VERSION)
      .catch(() => undefined);
  }

  // ───────────────────────── scheduling ─────────────────────────

  private async schedule(): Promise<void> {
    const now = Date.now();
    const want = this.opts.forceRun || shouldRun(now);
    try {
      if (want && !this.running && !this.starting) {
        if (now >= this.nextStartAt) await this.startFeed();
      }
      else if (!want && this.running) await this.stopFeed('session ended');
      else if (!this.running && now - this.idleStatusAt > 60_000) {
        this.idleStatusAt = now;
        await this.publisher.writeFeedStatus(this.idleStatus('idle', null), WORKER_VERSION);
      }
    } catch (err) {
      this.log('error', `Scheduler: ${(err as Error).message}`);
    }
  }

  private idleStatus(state: ProviderStatus['state'], note: string | null): ProviderStatus {
    const s = this.feed?.status();
    return {
      provider: 'Angel One SmartAPI (WebSocket 2.0)',
      dataKind: 'live',
      state,
      lastMessageAt: s?.lastMessageAt ?? null,
      lastTickAt: s?.lastTickAt ?? null,
      subscribed: 0,
      reconnects: s?.reconnects ?? 0,
      lastError: note,
    };
  }

  private async startFeed(): Promise<void> {
    this.starting = true;
    try {
      this.log('info', 'Starting session: login, instrument master, universe');
      await this.client.login();
      const master = await loadScripMaster(join(this.opts.dataDir ?? join(process.cwd(), 'data'), 'OpenAPIScripMaster.json'));
      const universe = buildUniverse(master.rows, Date.now());
      this.contracts = universe.contracts;
      this.contractsByToken.clear();
      for (const c of this.contracts) {
        for (const t of [c.cashToken, c.futToken]) {
          const list = this.contractsByToken.get(t) ?? [];
          list.push(c);
          this.contractsByToken.set(t, list);
        }
      }
      this.log('info', `Universe: ${new Set(this.contracts.map((c) => c.symbol)).size} stocks, ${this.contracts.length} contracts (master ${master.source} ${master.fetchedOn}, ${universe.skipped.length} rows skipped)`);
      await this.publisher.upsertContracts(this.contracts);

      this.store.clear();
      this.opps.clear();
      this.basis.clear();
      this.tradeDate = istDate(Date.now());

      const instruments = new Map<string, Instrument>();
      for (const c of this.contracts) {
        instruments.set(`NSE:${c.cashToken}`, { token: c.cashToken, exchange: 'NSE' });
        instruments.set(`NFO:${c.futToken}`, { token: c.futToken, exchange: 'NFO' });
      }
      const feed = new AngelStreamProvider(this.client, this.angel);
      feed.onQuote((q) => this.onQuote(q));
      feed.onStatus((s) => {
        if (s.state !== 'connected') this.log('warn', `Feed ${s.state}${s.lastError ? `: ${s.lastError}` : ''}`);
      });
      this.feed = feed;
      await feed.start([...instruments.values()]);
      this.running = true;
      this.log('info', `Streaming ${instruments.size} instruments`);
      if (await this.margins.loadCache()) this.log('info', `Loaded ${this.margins.size} cached broker margins`);
      // First fetch once quotes have arrived (prices are needed to express margins as a rate).
      setTimeout(() => void this.refreshMargins(), MARGIN_FIRST_FETCH_DELAY_MS);
      this.every(MARGIN_REFRESH_MS, () => this.refreshMargins());

      this.every(RECALC_DIRTY_MS, () => this.recalc(false));
      this.every(PUBLISH_TOP_MS, () => this.publish('top'));
      this.every(PUBLISH_FULL_MS, () => this.publish('full'));
      this.every(STATUS_MS, () => this.publisher.writeFeedStatus(feed.status(), WORKER_VERSION));
      this.every(SETTINGS_MS, () => this.refreshSettings());
      this.every(BASIS_SAMPLE_MS, () => this.sampleBasis());
      this.startBackoffMs = 60_000;
    } catch (err) {
      // Clean up so a failed start never leaves a session or socket behind.
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      await this.feed?.stop().catch(() => undefined);
      this.feed = null;
      this.running = false;
      await this.client.logout().catch(() => undefined);
      this.nextStartAt = Date.now() + this.startBackoffMs;
      this.log('error', `Start failed, retrying in ${Math.round(this.startBackoffMs / 1000)}s: ${(err as Error).message}`);
      this.startBackoffMs = Math.min(this.startBackoffMs * 2, 15 * 60_000);
    } finally {
      this.starting = false;
    }
  }

  private async stopFeed(reason: string): Promise<void> {
    this.log('info', `Stopping session (${reason})`);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try {
      this.recalc(true);
      await this.publish('full');
      await this.writeSessionSummary();
      if (sessionPhase(Date.now()) === 'closed' && this.lastPhase !== null) await this.writeCloseSnapshot();
    } catch (err) {
      this.log('error', `Final publish failed: ${(err as Error).message}`);
    }
    await this.feed?.stop();
    await this.client.logout().catch(() => undefined);
    this.running = false;
    await this.publisher.writeFeedStatus(this.idleStatus('idle', null), WORKER_VERSION).catch(() => undefined);
  }

  private every(ms: number, fn: () => unknown): void {
    let busy = false;
    this.timers.push(
      setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await fn();
        } catch (err) {
          this.log('error', (err as Error).message);
        } finally {
          busy = false;
        }
      }, ms),
    );
  }

  // ───────────────────────── calculation ─────────────────────────

  private onQuote(q: Quote): void {
    this.store.upsert(q);
    for (const c of this.contractsByToken.get(q.token) ?? []) this.dirty.add(c.futToken);
  }

  private async refreshMargins(): Promise<void> {
    if (!this.running || this.marginsBusy) return;
    this.marginsBusy = true;
    try {
      const feedLast = this.feed?.status().lastMessageAt ?? null;
      const started = Date.now();
      const r = await this.margins.refresh(
        this.client,
        this.contracts,
        (t) => this.store.get(t, feedLast)?.ltp ?? null,
        () => !this.running,
      );
      this.log('info', `Broker margins: ${r.updated} updated, ${r.failed} failed, ${r.skipped} without price (${Math.round((Date.now() - started) / 1000)}s)`);
      if (r.updated) this.recalc(true);
    } catch (err) {
      this.log('warn', `Margin refresh failed, using estimates where missing: ${(err as Error).message}`);
    } finally {
      this.marginsBusy = false;
    }
  }

  private async refreshSettings(): Promise<void> {
    try {
      const raw = (await this.publisher.readUserSettings()) ?? {};
      if (JSON.stringify(raw) !== JSON.stringify(this.settingsRaw)) {
        this.settingsRaw = raw;
        this.config = applySettings(raw);
        if (this.running) this.recalc(true);
        this.log('info', `Calculation settings loaded: ${JSON.stringify(raw)}`);
      }
    } catch (err) {
      this.log('warn', `Could not read user settings, using defaults: ${(err as Error).message}`);
    }
  }

  /** Recomputes changed contracts, or all of them (quote ages change even without ticks). */
  private recalc(all: boolean): void {
    const now = Date.now();
    const open = sessionPhase(now) === 'open';
    const feedLast = this.feed?.status().lastMessageAt ?? null;
    const targets = all ? this.contracts : this.contracts.filter((c) => this.dirty.has(c.futToken));
    for (const c of targets) {
      this.opps.set(
        c.futToken,
        computeOpportunity({
          contract: c,
          cashQuote: this.store.get(c.cashToken, feedLast),
          futQuote: this.store.get(c.futToken, feedLast),
          now,
          config: this.config,
          marketOpen: open,
          marginRate: this.margins.rate(c.futToken),
        }),
      );
    }
    if (all) this.dirty.clear();
    else for (const c of targets) this.dirty.delete(c.futToken);
  }

  private buildMessage(kind: 'top' | 'full'): WireMessage {
    const all = [...this.opps.values()];
    const s = summarize(all);
    const summary: WireSummary = {
      stocks: s.stocks,
      contracts: s.contracts,
      executable: s.executable,
      beatingFundingRate: s.beatingFundingRate,
      unprofitable: s.unprofitable,
      research: s.research,
      excluded: s.excluded,
      stale: s.stale,
      passingQuality: s.passingQuality,
      bestYieldAfterCosts: s.bestAnnualizedYield?.value ?? null,
      bestNetProfitPerLot: s.bestNetProfitPerLot?.value ?? null,
    };
    const fs = this.feed?.status();
    const feed: WireFeed = {
      provider: fs?.provider ?? 'Angel One SmartAPI (WebSocket 2.0)',
      dataKind: 'live',
      state: fs?.state ?? 'idle',
      lastTickAt: fs?.lastTickAt ?? null,
      lastMessageAt: fs?.lastMessageAt ?? null,
      subscribed: fs?.subscribed ?? 0,
      reconnects: fs?.reconnects ?? 0,
      lastError: fs?.lastError ?? null,
      session: sessionPhase(Date.now()),
    };
    const chosen =
      kind === 'full'
        ? all
        : rankOpportunities(all.filter((o) => o.economics), 'yieldAfterCosts')
            .slice(0, TOP_ROWS)
            .map((r) => r.opportunity);
    const rows = chosen.map((o) =>
      withTopQuantities(toWireRow(o), this.store.get(o.contract.cashToken, null), this.store.get(o.contract.futToken, null)),
    );
    return { kind, at: Date.now(), version: WORKER_VERSION, feed, summary, settings: this.settingsRaw, rows };
  }

  private async publish(kind: 'top' | 'full'): Promise<void> {
    // Capture the session summary from the last calculation made while the market was open,
    // before rows flip to "market closed".
    const phase = sessionPhase(Date.now());
    if (this.lastPhase === 'open' && phase !== 'open') await this.writeSessionSummary();
    // After the derivatives close both legs have final prices: save the closing-prices view.
    if (this.lastPhase === 'fo_only' && phase === 'closed') await this.writeCloseSnapshot();
    this.lastPhase = phase;
    this.recalc(true);
    const msg = this.buildMessage(kind);
    // The full universe exceeds the broadcast size limit, so it goes to the snapshot table and
    // only a small notice is broadcast; the dashboard then fetches the table (gzip-compressed).
    if (kind === 'full') await this.publisher.writeSnapshot(msg);
    const payload = kind === 'full' ? { at: msg.at, feed: msg.feed, summary: msg.summary } : msg;
    try {
      const bytes = await this.publisher.broadcast(kind === 'full' ? 'snapshot' : 'top', payload);
      if (kind === 'top' && !this.loggedTopSize) {
        this.loggedTopSize = true;
        this.log('info', `Top-${msg.rows.length} broadcast size: ${(bytes / 1024).toFixed(1)} KB`);
      }
      if (this.broadcastError) this.log('info', 'Realtime broadcast recovered');
      this.broadcastError = null;
    } catch (err) {
      const text = (err as Error).message;
      if (text !== this.broadcastError) this.log('error', `${text} (snapshot table still updated every 60s)`);
      this.broadcastError = text;
    }
    if (kind === 'full') {
      const s = msg.summary;
      this.log('info', `Published: ${s.executable} profitable after costs (${s.beatingFundingRate} beat funding), ${s.unprofitable} unprofitable, ${s.excluded} excluded; best ${s.bestYieldAfterCosts?.toFixed(2) ?? '—'}% p.a.`);
    }
  }

  // ───────────────────────── history ─────────────────────────

  private async sampleBasis(): Promise<void> {
    const now = Date.now();
    if (sessionPhase(now) !== 'open') return;
    const feedLast = this.feed?.status().lastMessageAt ?? null;
    const mid = (q: Quote | undefined) => {
      const b = q?.bids[0]?.price;
      const a = q?.asks[0]?.price;
      return b && a ? (a + b) / 2 : (q?.ltp ?? null);
    };
    const samples: BasisSample[] = [];
    for (const c of this.contracts) {
      const o = this.opps.get(c.futToken);
      if (!o || o.exclusionReasons.some((r) => r.startsWith('STALE') || r.startsWith('MISSING'))) continue;
      const cash = mid(this.store.get(c.cashToken, feedLast));
      const fut = mid(this.store.get(c.futToken, feedLast));
      if (!cash || !fut) continue;
      const basisPct = ((fut - cash) / cash) * 100;
      samples.push({ futToken: c.futToken, symbol: c.symbol, expiry: c.expiry, cashPrice: cash, futPrice: fut, basisPct });
      const acc = this.basis.get(c.futToken) ?? { symbol: c.symbol, expiry: c.expiry, sum: 0, n: 0, min: Infinity, max: -Infinity, last: 0 };
      acc.sum += basisPct;
      acc.n++;
      acc.min = Math.min(acc.min, basisPct);
      acc.max = Math.max(acc.max, basisPct);
      acc.last = basisPct;
      this.basis.set(c.futToken, acc);
    }
    // Round down to the 5-minute bucket so samples line up across contracts.
    const bucket = Math.floor(now / BASIS_SAMPLE_MS) * BASIS_SAMPLE_MS;
    await this.publisher.insertBasisSamples(bucket, samples);
    await this.publisher.upsertBasisDaily(
      this.tradeDate,
      [...this.basis].map(([futToken, a]) => ({
        futToken,
        symbol: a.symbol,
        expiry: a.expiry,
        close: a.last,
        avg: a.sum / a.n,
        min: a.min,
        max: a.max,
        samples: a.n,
      })),
    );
    await this.publisher.pruneBasisHistory(now - HISTORY_RETENTION_MS);
  }

  private async writeCloseSnapshot(): Promise<void> {
    if (this.closeWrittenFor === this.tradeDate || !this.contracts.length) return;
    const feedLast = this.feed?.status().lastMessageAt ?? null;
    const msg = buildCloseMessage({
      contracts: this.contracts,
      quote: (t) => this.store.get(t, feedLast),
      marginRate: (t) => this.margins.rate(t),
      now: Date.now(),
      settingsRaw: this.settingsRaw,
      feed: this.buildMessage('top').feed,
      version: WORKER_VERSION,
    });
    await this.publisher.writeCloseSnapshot(msg);
    this.closeWrittenFor = this.tradeDate;
    this.log('info', `Closing-prices snapshot saved for ${msg.tradeDate} (${msg.rows.length} contracts)`);
  }

  private async writeSessionSummary(): Promise<void> {
    const all = [...this.opps.values()];
    if (!all.length || this.summaryWrittenFor === this.tradeDate) return;
    if (!all.some((o) => o.economics)) return; // nothing was tradable (started after the close)
    this.summaryWrittenFor = this.tradeDate;
    this.log('info', 'Writing end-of-session summary');
    const top = rankOpportunities(all.filter((o) => o.economics), 'yieldAfterCosts').slice(0, 10);
    await this.publisher.writeSessionSummary(this.tradeDate, {
      writtenAt: new Date().toISOString(),
      summary: summarize(all),
      top: top.map((r) => ({
        symbol: r.opportunity.contract.symbol,
        expiry: r.opportunity.contract.expiry,
        yieldAfterCosts: metricValue(r.opportunity, 'yieldAfterCosts'),
        netProfitPerLot: metricValue(r.opportunity, 'netProfitPerLot'),
        status: r.opportunity.status,
        row: toWireRow(r.opportunity),
      })),
      ticks: this.feed?.ticks ?? 0,
    });
  }
}
