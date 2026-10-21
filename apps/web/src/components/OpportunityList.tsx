"use client";

import { ChevronRight, Star } from "lucide-react";
import { sessionPhase } from "@arb/core";
import { compactRupees, expiryLabel, num, pct, rupees } from "@/lib/format";
import type { RowState } from "@/lib/useScreener";
import { REASON_LABEL, rowIsStale, STATUS_LABEL, WARNING_LABEL } from "@/lib/view";
import { QualityMeter } from "./ui";

type Phase = ReturnType<typeof sessionPhase>;

const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v > 0 ? "text-up" : v < 0 ? "text-down" : "";

export function StatusBadge({ row, stale, closeMode }: { row: RowState["row"]; stale: boolean; closeMode: boolean }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold";
  if (closeMode && row.st !== "excluded") return <span className={`${base} bg-warn-bg text-warn`}>At close</span>;
  if (stale) return <span className={`${base} bg-warn-bg text-warn`}>Stale</span>;
  if (row.st === "executable") return <span className={`${base} bg-up-bg text-up`}>● Profitable</span>;
  if (row.st === "unprofitable") return <span className={`${base} bg-down-bg text-down`}>Unprofitable</span>;
  return <span className={`${base} bg-panel-2 text-muted`}>{STATUS_LABEL[row.st]}</span>;
}

export function OpportunityCard({
  state,
  rank,
  closeMode,
  stale,
  watched,
  fundingPct,
  onOpen,
  onStar,
}: {
  state: RowState;
  rank: number;
  closeMode: boolean;
  stale: boolean;
  watched: boolean;
  fundingPct: number;
  onOpen: () => void;
  onStar: () => void;
}) {
  const r = state.row;
  const [yieldAC, excess, netLot, , , grossPct, , , , quality] = r.m;
  const hidden = new Set<string>(closeMode ? ["THEORETICAL_LTP_MODE", "NON_LIVE_DATA"] : []);
  const warnings = r.w.filter((w) => !hidden.has(w)).map((w) => WARNING_LABEL[w]).filter(Boolean).slice(0, 2);
  const excluded = r.st === "excluded";

  return (
    <li className={`card-lift overflow-hidden rounded-3xl border border-line bg-panel ${stale ? "opacity-60" : ""}`}>
      <div className="flex">
        <button onClick={onOpen} className="min-w-0 flex-1 p-4 text-left" aria-label={`${r.s} details`}>
          {/* Line 1: name + status */}
          <div className="flex items-center gap-2">
            <span className="num w-5 text-xs text-muted">{rank}</span>
            <span className="truncate text-[17px] font-semibold tracking-tight">{r.s}</span>
            <span className="ml-auto"><StatusBadge row={r} stale={stale} closeMode={closeMode} /></span>
          </div>
          <p className="mt-0.5 pl-7 text-xs text-muted">
            {expiryLabel(r.e)} expiry · {r.d === 0 ? "expires today" : `${r.d} day${r.d === 1 ? "" : "s"} left`} · lot {num(r.l, 0)}
          </p>

          {excluded ? (
            <p className="mt-3 pl-7 text-sm text-muted">{r.x.map((x) => REASON_LABEL[x]).join(" · ")}</p>
          ) : (
            <>
              {/* Line 2: the two numbers that matter */}
              <div className="mt-3 flex items-end gap-3 pl-7">
                <div>
                  <p className={`num text-[26px] font-semibold leading-none tracking-tight ${tone(yieldAC)}`}>{pct(yieldAC)}</p>
                  <p className="mt-1 text-[11px] text-muted">a year, after all costs</p>
                </div>
                <div className="ml-auto text-right">
                  <p className={`num text-lg font-semibold leading-none ${tone(netLot)}`}>{rupees(netLot)}</p>
                  <p className="mt-1 text-[11px] text-muted">profit per lot</p>
                </div>
              </div>
              {/* Line 3: context */}
              <div className="mt-3 flex items-center gap-2 pl-7 text-xs">
                <span className={`num rounded-full px-2 py-0.5 ${excess !== null && excess > 0 ? "bg-up-bg text-up" : "bg-panel-2 text-muted"}`}>
                  {excess !== null && excess > 0 ? `Beats ${num(fundingPct, 0)}% by ${pct(excess)}` : `Below ${num(fundingPct, 0)}% by ${pct(excess !== null ? -excess : null)}`}
                </span>
                <span className="num text-muted">gap {pct(grossPct)}</span>
                <span className="ml-auto"><QualityMeter score={quality} /></span>
              </div>
            </>
          )}
          {warnings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 pl-7">
              {warnings.map((w) => (
                <span key={w} className="rounded-full bg-warn-bg px-2 py-0.5 text-[10px] font-medium text-warn">{w}</span>
              ))}
            </div>
          )}
        </button>
        <div className="flex flex-col items-center justify-between py-3 pr-2">
          <button
            onClick={onStar}
            className={`rounded-full p-2 transition active:scale-90 ${watched ? "text-warn" : "text-muted/60"}`}
            aria-label={watched ? `Remove ${r.s} from watchlist` : `Add ${r.s} to watchlist`}
            aria-pressed={watched}
          >
            <Star size={20} fill={watched ? "currentColor" : "none"} />
          </button>
          <ChevronRight size={18} className="mb-1 text-muted/60" aria-hidden />
        </div>
      </div>
    </li>
  );
}

export function DesktopTable({
  rows,
  now,
  phase,
  closeMode,
  watchlist,
  onOpen,
  onStar,
}: {
  rows: RowState[];
  now: number;
  phase: Phase;
  closeMode: boolean;
  watchlist: ReadonlySet<string>;
  onOpen: (k: string) => void;
  onStar: (s: string) => void;
}) {
  const head = ["#", "", "Stock", "Expiry", "Days", closeMode ? "Cash close" : "Buy at", closeMode ? "Fut close" : "Sell at", "Gap", "Profit / lot", "Yield / yr", "vs funding", "Charges", "Lot", "Turnover", "Quality", "Status"];
  return (
    <div className="hidden overflow-hidden rounded-3xl border border-line bg-panel md:block">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              {head.map((h, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((st, i) => {
              const r = st.row;
              const stale = !closeMode && rowIsStale(st, now, phase);
              const w = watchlist.has(r.s);
              return (
                <tr
                  key={r.k}
                  onClick={() => onOpen(r.k)}
                  className={`num cursor-pointer whitespace-nowrap border-t border-line transition hover:bg-panel-2 ${stale ? "opacity-60" : ""}`}
                >
                  <td className="px-3 py-2.5 text-muted">{i + 1}</td>
                  <td className="px-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStar(r.s);
                      }}
                      className={w ? "text-warn" : "text-muted/50"}
                      aria-label={w ? `Remove ${r.s} from watchlist` : `Add ${r.s} to watchlist`}
                    >
                      <Star size={16} fill={w ? "currentColor" : "none"} />
                    </button>
                  </td>
                  <td className="px-3 font-semibold">{r.s}</td>
                  <td className="px-3 text-muted">{expiryLabel(r.e)}</td>
                  <td className="px-3">{r.d}</td>
                  <td className="px-3">{num(closeMode ? r.c[0] : r.c[3])}</td>
                  <td className="px-3">{num(closeMode ? r.f[0] : r.f[1])}</td>
                  <td className="px-3">{pct(r.m[5])}</td>
                  <td className={`px-3 ${tone(r.m[2])}`}>{rupees(r.m[2])}</td>
                  <td className={`px-3 font-semibold ${tone(r.m[0])}`}>{pct(r.m[0])}</td>
                  <td className={`px-3 ${tone(r.m[1])}`}>{pct(r.m[1], 2, true)}</td>
                  <td className="px-3 text-muted">{rupees(r.m[7])}</td>
                  <td className="px-3 text-muted">{num(r.l, 0)}</td>
                  <td className="px-3 text-muted">{compactRupees(r.c[5])}</td>
                  <td className="px-3"><QualityMeter score={r.m[9]} /></td>
                  <td className="px-3"><StatusBadge row={r} stale={stale} closeMode={closeMode} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
