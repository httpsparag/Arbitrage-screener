"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { ArrowRight, CircleHelp, House, Moon, Search, Settings, SlidersHorizontal, Sparkles, Star, WifiOff, X } from "lucide-react";
import { applySettings, sessionPhase, type UserCalcSettings } from "@arb/core";
import { getSupabase } from "@/lib/supabase";
import { useNow, useScreener, type RowState } from "@/lib/useScreener";
import { useUserData } from "@/lib/useUserData";
import { useCloseSnapshot } from "@/lib/useCloseSnapshot";
import { ago, expiryLabel, num, pct, rupees } from "@/lib/format";
import {
  DEFAULT_FILTERS,
  liveStatus,
  rowIsStale,
  selectRows,
  SORT_LABEL,
  type DataMode,
  type Filters,
  type Tone,
  type View,
} from "@/lib/view";
import { DetailSheet } from "./DetailSheet";
import { activeFilterCount, FiltersSheet } from "./FiltersSheet";
import { HelpSheet } from "./HelpSheet";
import { DesktopTable, OpportunityCard } from "./OpportunityList";
import { ControlPanel } from "./ControlPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Explain, IconButton } from "./ui";

const FILTERS_KEY = "arb.filters.v1";
type Tab = "home" | "watchlist" | "settings";

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    return raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw), watchOnly: false } : DEFAULT_FILTERS;
  } catch {
    return DEFAULT_FILTERS;
  }
}

const PILL: Record<Tone, string> = {
  live: "bg-up-bg text-up",
  warn: "bg-warn-bg text-warn",
  down: "bg-down-bg text-down",
  idle: "bg-panel-2 text-muted",
};

export function Dashboard({ session }: { session: Session }) {
  const now = useNow(1000);
  const data = useScreener(true);
  const user = useUserData(session.user.id);
  const close = useCloseSnapshot(true);
  // Rendered only in the browser (see page.tsx), so reading localStorage here is safe.
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [tab, setTab] = useState<Tab>("home");
  const [selected, setSelected] = useState<string | null>(null);
  // List order frozen while a detail sheet is open, so rows don't jump under the user.
  const [frozen, setFrozen] = useState<RowState[] | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // While the market is closed, show the closing-prices view unless the user switches to the last live update.
  const [preferLive, setPreferLive] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // storage unavailable (private mode); filters simply won't persist
    }
  }, [filters]);

  const status = liveStatus(now, data.lastMessageAt, data.feed, data.channel);
  const phase = sessionPhase(now);
  const closeMsg = close.snapshot?.message ?? null;
  const mode: DataMode = phase !== "open" && closeMsg && !preferLive ? "close" : "live";
  const settingsUsed = (mode === "close" ? closeMsg?.settings : data.settings) ?? {};
  const fundingPct = applySettings(settingsUsed as UserCalcSettings).funding.ownCapitalRate * 100;

  const liveRows = useMemo(() => [...data.rows.values()], [data.rows]);
  const closeRows = useMemo<RowState[]>(
    () => (closeMsg ? closeMsg.rows.map((row) => ({ row, at: closeMsg.at })) : []),
    [closeMsg],
  );
  const allRows = mode === "close" ? closeRows : liveRows;

  // Re-filter on new data, filter changes, and every 5 s so row staleness is re-evaluated.
  const filterNow = Math.floor(now / 5000) * 5000;
  const effective = useMemo<Filters>(
    () => (tab === "watchlist" ? { ...filters, view: "all", expiry: "all", minYield: null, maxCapital: null, watchOnly: true } : filters),
    [filters, tab],
  );
  const live = useMemo(
    () => selectRows(allRows, effective, user.watchlist, filterNow, mode),
    [allRows, effective, user.watchlist, filterNow, mode],
  );
  const rows = frozen ?? live;

  const counts = useMemo(() => {
    const c: Partial<Record<View, number>> = {};
    for (const v of ["profitable", "beats", "research", "excluded", "all"] as View[]) {
      c[v] = selectRows(allRows, { ...filters, view: v }, user.watchlist, filterNow, mode).length;
    }
    return c;
  }, [allRows, filters, user.watchlist, filterNow, mode]);

  const best = useMemo(() => {
    const top = selectRows(allRows, { ...DEFAULT_FILTERS, view: "profitable" }, user.watchlist, filterNow, mode)[0];
    return top && (top.row.m[0] ?? 0) > 0 ? top : null;
  }, [allRows, user.watchlist, filterNow, mode]);

  const open = (k: string) => {
    setFrozen(live);
    setSelected(k);
  };
  const closeDetail = () => {
    setSelected(null);
    setFrozen(null);
  };
  const selectedState = selected ? (allRows.find((x) => x.row.k === selected) ?? null) : null;
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const signOut = () => void getSupabase().auth.signOut();
  const filterBadge = activeFilterCount(filters);
  const stocks = new Set(allRows.map((x) => x.row.s)).size;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* ───── Top bar ───── */}
      <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
          <div className="brand-mark h-8 w-8 shrink-0 rounded-xl" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold leading-tight">Arb Screener</h1>
            <p className="text-[11px] text-muted">Cash–futures arbitrage · NSE</p>
          </div>
          <nav className="ml-6 hidden gap-1 md:flex" aria-label="Sections">
            {(["home", "watchlist", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-full px-4 py-2 text-sm capitalize ${tab === t ? "bg-panel-2 font-medium text-text" : "text-muted"}`}
              >
                {t === "home" ? "Opportunities" : t}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${PILL[status.tone]}`}>
              <span className={`h-2 w-2 rounded-full ${status.tone === "live" ? "live-dot bg-up" : status.tone === "warn" ? "bg-warn" : status.tone === "down" ? "bg-down" : "bg-muted"}`} aria-hidden />
              {status.label}
            </span>
            <IconButton label="How it works" onClick={() => setShowHelp(true)}>
              <CircleHelp size={18} />
            </IconButton>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-28 md:pb-10">
        {tab === "settings" ? (
          <div className="mx-auto max-w-xl">
            <h2 className="mb-4 text-2xl font-semibold tracking-tight">Settings</h2>
            <div className="mb-6">
              <ControlPanel now={now} />
            </div>
            <SettingsPanel
              email={session.user.email}
              settings={user.settings}
              workerSettings={data.settings}
              onSave={user.saveSettings}
              onSignOut={signOut}
              onHelp={() => setShowHelp(true)}
            />
          </div>
        ) : (
          <>
            {tab === "home" ? (
              <>
                {/* ───── Status headline ───── */}
                <Hero
                  mode={mode}
                  tone={status.tone}
                  label={status.label}
                  detail={status.detail}
                  hasData={allRows.length > 0}
                  profitable={counts.profitable ?? 0}
                  stocks={stocks}
                  tradeDate={close.snapshot?.tradeDate ?? null}
                  closeAvailable={!!closeMsg && phase !== "open"}
                  onShowLive={() => setPreferLive(true)}
                  onShowClose={() => setPreferLive(false)}
                />

                {/* ───── Best right now ───── */}
                {best && (
                  <button onClick={() => open(best.row.k)} className="best-card mt-3 w-full overflow-hidden rounded-3xl p-5 text-left text-white">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-white/80">
                      <Sparkles size={14} /> {mode === "close" ? "Best at today's close" : "Best right now"}
                    </p>
                    <div className="mt-2 flex items-end gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-2xl font-semibold tracking-tight">{best.row.s}</p>
                        <p className="text-xs text-white/75">
                          {expiryLabel(best.row.e)} expiry · {best.row.d} days · lot {num(best.row.l, 0)}
                        </p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="num text-3xl font-semibold leading-none tracking-tight">{pct(best.row.m[0])}</p>
                        <p className="mt-1 text-xs text-white/75">a year after costs</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-white/20 pt-3 text-sm">
                      <span className="num">{rupees(best.row.m[2])} profit per lot</span>
                      <span className="inline-flex items-center gap-1 font-medium">
                        See the trade <ArrowRight size={16} />
                      </span>
                    </div>
                  </button>
                )}

                {/* ───── Quick numbers ───── */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Stat label={mode === "close" ? "Positive at close" : "Profitable now"} value={num(counts.profitable ?? 0, 0)} accent />
                  <Stat label={`Beat ${num(fundingPct, 0)}% rate`} value={num(counts.beats ?? 0, 0)} />
                  <Stat label="Stocks scanned" value={num(stocks, 0)} />
                </div>

                {/* ───── Search, views, filters ───── */}
                <div className="sticky top-[calc(env(safe-area-inset-top)+64px)] z-20 -mx-4 mt-4 bg-bg/85 px-4 py-2 backdrop-blur-xl">
                  <div className="flex items-center gap-2">
                    {searchOpen || filters.search ? (
                      <div className="flex flex-1 items-center gap-2 rounded-full border border-line bg-panel px-4 py-2.5">
                        <Search size={16} className="text-muted" />
                        <input
                          autoFocus
                          value={filters.search}
                          onChange={(e) => set({ search: e.target.value })}
                          placeholder="Search a stock, e.g. RELIANCE"
                          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
                          inputMode="search"
                          autoCapitalize="characters"
                        />
                        <button
                          onClick={() => {
                            set({ search: "" });
                            setSearchOpen(false);
                          }}
                          aria-label="Clear search"
                          className="text-muted"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ) : (
                      <div className="no-scrollbar flex flex-1 gap-2 overflow-x-auto" role="tablist" aria-label="Show">
                        {([
                          ["profitable", "Profitable"],
                          ["beats", `Beats ${num(fundingPct, 0)}%`],
                          ["all", "All"],
                          ["research", "Unprofitable"],
                          ["excluded", "Excluded"],
                        ] as [View, string][]).map(([id, label]) => (
                          <button
                            key={id}
                            role="tab"
                            aria-selected={filters.view === id}
                            onClick={() => set({ view: id })}
                            className={`shrink-0 rounded-full border px-3.5 py-2 text-sm transition ${
                              filters.view === id ? "border-transparent bg-text font-medium text-bg" : "border-line bg-panel text-muted"
                            }`}
                          >
                            {label} <span className="num opacity-60">{counts[id] ?? 0}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {!searchOpen && !filters.search && (
                      <IconButton label="Search" onClick={() => setSearchOpen(true)}>
                        <Search size={18} />
                      </IconButton>
                    )}
                    <IconButton label="Filter and sort" onClick={() => setShowFilters(true)} active={filterBadge > 0}>
                      <SlidersHorizontal size={18} />
                      {filterBadge > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                          {filterBadge}
                        </span>
                      )}
                    </IconButton>
                  </div>
                </div>
              </>
            ) : (
              <div className="mb-2">
                <h2 className="text-2xl font-semibold tracking-tight">Watchlist</h2>
                <p className="mt-1 text-sm text-muted">
                  {mode === "close" ? "At today's closing prices" : "Live"} · every expiry of the stocks you follow
                </p>
              </div>
            )}

            {/* ───── List ───── */}
            <div className="mt-2 mb-2 flex items-center gap-1.5 text-xs text-muted">
              <span>
                {rows.length} {rows.length === 1 ? "contract" : "contracts"} · sorted by {SORT_LABEL[filters.sort].toLowerCase()}
              </span>
              <Explain term="status" />
              {selected && <span className="ml-auto">list paused</span>}
            </div>

            {rows.length === 0 ? (
              <EmptyState tab={tab} hasData={allRows.length > 0} view={filters.view} />
            ) : (
              <>
                <ul className="space-y-3 md:hidden">
                  {rows.map((st, i) => (
                    <OpportunityCard
                      key={st.row.k}
                      state={st}
                      rank={i + 1}
                      closeMode={mode === "close"}
                      stale={mode === "live" && rowIsStale(st, now, phase)}
                      watched={user.watchlist.has(st.row.s)}
                      fundingPct={fundingPct}
                      onOpen={() => open(st.row.k)}
                      onStar={() => void user.toggleWatch(st.row.s)}
                    />
                  ))}
                </ul>
                <DesktopTable
                  rows={rows}
                  now={now}
                  phase={phase}
                  closeMode={mode === "close"}
                  watchlist={user.watchlist}
                  onOpen={open}
                  onStar={(sym) => void user.toggleWatch(sym)}
                />
              </>
            )}

            <p className="mx-auto mt-8 max-w-md text-center text-[11px] leading-relaxed text-muted">
              Estimates, not guaranteed returns. Figures assume holding to expiry and include all charges for 1 position.
              {data.lastFullAt ? ` Full refresh ${ago(now - data.lastFullAt)}.` : ""}
            </p>
          </>
        )}
      </main>

      {/* ───── Bottom tab bar (phones) ───── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line/60 bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
        aria-label="Sections"
      >
        <div className="mx-auto grid max-w-md grid-cols-3">
          <TabButton icon={<House size={22} />} label="Home" active={tab === "home"} onClick={() => setTab("home")} />
          <TabButton
            icon={<Star size={22} fill={tab === "watchlist" ? "currentColor" : "none"} />}
            label="Watchlist"
            badge={user.watchlist.size || undefined}
            active={tab === "watchlist"}
            onClick={() => setTab("watchlist")}
          />
          <TabButton icon={<Settings size={22} />} label="Settings" active={tab === "settings"} onClick={() => setTab("settings")} />
        </div>
      </nav>

      {selectedState && (
        <DetailSheet
          state={selectedState}
          settingsRaw={settingsUsed}
          now={now}
          closeMode={mode === "close"}
          stale={mode === "live" && rowIsStale(selectedState, now, phase)}
          watched={user.watchlist.has(selectedState.row.s)}
          onStar={() => void user.toggleWatch(selectedState.row.s)}
          onClose={closeDetail}
        />
      )}
      {showFilters && (
        <FiltersSheet
          filters={filters}
          counts={counts}
          resultCount={live.length}
          onChange={set}
          onClose={() => setShowFilters(false)}
        />
      )}
      {showHelp && <HelpSheet onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function Hero({
  mode,
  tone,
  label,
  detail,
  hasData,
  profitable,
  stocks,
  tradeDate,
  closeAvailable,
  onShowLive,
  onShowClose,
}: {
  mode: DataMode;
  tone: Tone;
  label: string;
  detail: string;
  hasData: boolean;
  profitable: number;
  stocks: number;
  tradeDate: string | null;
  closeAvailable: boolean;
  onShowLive: () => void;
  onShowClose: () => void;
}) {
  if (mode === "close") {
    return (
      <section className="rounded-3xl border border-line bg-panel p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-muted">
          <Moon size={16} /> Market closed
        </p>
        <h2 className="mt-1.5 text-[22px] font-semibold leading-snug tracking-tight">
          {profitable} contracts were positive at {tradeDate ? `${expiryLabel(tradeDate)}'s` : "the"} close
        </h2>
        <p className="mt-1.5 flex items-center gap-1 text-sm text-muted">
          Closing prices, for review only — not tradable. <Explain term="closing" />
        </p>
        <button onClick={onShowLive} className="mt-3 text-sm font-medium text-accent">
          Show the last live update instead
        </button>
      </section>
    );
  }
  if (!hasData) {
    return (
      <section className="rounded-3xl border border-line bg-panel p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-muted">
          <WifiOff size={16} /> Waiting for prices
        </p>
        <h2 className="mt-1.5 text-[22px] font-semibold leading-snug tracking-tight">No data yet</h2>
        <p className="mt-1.5 text-sm text-muted">
          The cloud scanner fills this in automatically on weekdays from 09:15. Check Settings → Cloud scanner for its status.
        </p>
      </section>
    );
  }
  const headline =
    tone === "live"
      ? profitable > 0
        ? `${profitable} ${profitable === 1 ? "trade beats" : "trades beat"} all costs right now`
        : "Nothing beats costs right now"
      : tone === "idle"
        ? "Market is not in continuous trading"
        : "Prices are not fresh";
  return (
    <section className="rounded-3xl border border-line bg-panel p-5">
      <p className={`flex items-center gap-1.5 text-sm font-medium ${tone === "live" ? "text-up" : tone === "idle" ? "text-muted" : "text-warn"}`}>
        {label} <Explain term="live" />
      </p>
      <h2 className="mt-1.5 text-[22px] font-semibold leading-snug tracking-tight">{headline}</h2>
      <p className="mt-1.5 text-sm text-muted">
        {detail} · {stocks} stocks scanned
      </p>
      {closeAvailable && (
        <button onClick={onShowClose} className="mt-3 text-sm font-medium text-accent">
          Show today&apos;s closing prices
        </button>
      )}
    </section>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-panel px-3 py-3">
      <p className={`num text-xl font-semibold tracking-tight ${accent ? "text-up" : ""}`}>{value}</p>
      <p className="mt-0.5 text-[11px] leading-tight text-muted">{label}</p>
    </div>
  );
}

function TabButton({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-center gap-0.5 pt-2.5 pb-2 text-[11px] font-medium transition ${active ? "text-text" : "text-muted"}`}
      aria-current={active ? "page" : undefined}
    >
      <span className={`flex h-8 w-14 items-center justify-center rounded-full transition ${active ? "bg-panel-2" : ""}`}>{icon}</span>
      {label}
      {badge !== undefined && (
        <span className="num absolute top-1.5 left-1/2 ml-3 rounded-full bg-warn px-1.5 text-[10px] font-bold text-bg">{badge}</span>
      )}
    </button>
  );
}

function EmptyState({ tab, hasData, view }: { tab: Tab; hasData: boolean; view: View }) {
  const [title, body] =
    tab === "watchlist"
      ? ["Your watchlist is empty", "Tap the ☆ on any stock to follow it here — all its expiries will show together."]
      : !hasData
        ? ["No data yet", "The cloud scanner publishes prices on weekdays from 09:15. See Settings → Cloud scanner."]
        : view === "profitable" || view === "beats"
          ? ["Nothing qualifies right now", "When charges are bigger than the price gaps, nothing is shown as profitable. Try “All”, or check again during market hours."]
          : ["No matches", "Try clearing the search or relaxing the filters."];
  return (
    <div className="rounded-3xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}
