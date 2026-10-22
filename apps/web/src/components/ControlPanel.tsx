"use client";

import { CalendarClock, CirclePause, CirclePlay, KeyRound, ListRestart, Moon, RefreshCw } from "lucide-react";
import { istDate } from "@arb/core";
import { ago } from "@/lib/format";
import { useScanner } from "@/lib/useScanner";

const STATE: Record<string, { label: string; cls: string; dot: string }> = {
  running: { label: "Running", cls: "bg-up-bg text-up", dot: "live-dot bg-up" },
  idle: { label: "Idle", cls: "bg-panel-2 text-muted", dot: "bg-muted" },
  paused: { label: "Paused", cls: "bg-warn-bg text-warn", dot: "bg-warn" },
  error: { label: "Error", cls: "bg-down-bg text-down", dot: "bg-down" },
};

export function ControlPanel({ now }: { now: number }) {
  const s = useScanner(true, istDate(now));
  const st = s.status;
  const lastRun = st?.last_run_at ? Date.parse(st.last_run_at) : null;
  // Scheduled scans run every minute in market hours; silence for 3+ minutes then means trouble.
  const silent = st?.state === "running" && lastRun !== null && now - lastRun > 3 * 60_000;
  const look = silent ? STATE.error : STATE[st?.state ?? "idle"] ?? STATE.idle;

  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">Cloud scanner</h3>
      <div className="overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="flex items-center gap-3 px-4 py-4">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${look.cls}`}>
            <span className={`h-2 w-2 rounded-full ${look.dot}`} aria-hidden />
            {silent ? "Not responding" : look.label}
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-muted">
            {st?.message ?? (st?.state === "running" ? "Scanning every 30 seconds" : "Waiting for market hours")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line text-sm">
          <Info label="Last scan" value={lastRun ? ago(now - lastRun) : "—"} />
          <Info label="Prices fetched" value={st?.quotes_fetched != null ? `${st.quotes_fetched}` : "—"} />
          <Info label="Contracts" value={st?.contracts != null ? `${st.contracts}` : "—"} />
          <Info label="Broker margins" value={st?.margins_known != null ? `${st.margins_known}` : "—"} />
        </div>
        {st?.last_error && (
          <p className="border-t border-line px-4 py-3 text-xs text-down">
            Last error {st.last_error_at ? ago(now - Date.parse(st.last_error_at)) : ""}: {st.last_error}
          </p>
        )}
        <div className="border-t border-line px-4 py-3 text-xs leading-relaxed text-muted">
          <p className="flex items-center gap-1.5">
            <CalendarClock size={14} /> Runs by itself on weekdays: contract list at 08:30, scans 09:15–15:15 every 30 s, closing view after 15:40.
          </p>
          {st?.universe_refreshed_at && <p className="mt-1 pl-5">Contract list refreshed {ago(now - Date.parse(st.universe_refreshed_at))}.</p>}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Action icon={<RefreshCw size={18} />} label="Scan now" busy={s.busy === "scan"} onClick={() => s.run("scan", "Scan")} />
        {s.pausedToday ? (
          <Action icon={<CirclePlay size={18} />} label="Resume today" busy={s.busy === "pause"} onClick={() => s.setPaused(false)} tone="warn" />
        ) : (
          <Action icon={<CirclePause size={18} />} label="Pause today" busy={s.busy === "pause"} onClick={() => s.setPaused(true)} />
        )}
        <Action icon={<Moon size={18} />} label="Rebuild closing view" busy={s.busy === "close"} onClick={() => s.run("close", "Closing view")} />
        <Action icon={<ListRestart size={18} />} label="Refresh contract list" busy={s.busy === "refresh-universe"} onClick={() => s.run("refresh-universe", "Contract refresh")} />
        <Action icon={<KeyRound size={18} />} label="Re-login Angel One" busy={s.busy === "relogin"} onClick={() => s.run("relogin", "Re-login")} />
      </div>
      {s.note && (
        <p className={`mt-3 rounded-2xl px-4 py-3 text-sm ${s.note.ok ? "bg-up-bg text-up" : "bg-down-bg text-down"}`} role="status">
          {s.note.text}
        </p>
      )}
      {s.pausedToday && (
        <p className="mt-3 rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">Scheduled scans are paused for the rest of today. They resume automatically tomorrow.</p>
      )}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="num mt-0.5 font-medium">{value}</p>
    </div>
  );
}

function Action({
  icon,
  label,
  onClick,
  busy,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  busy: boolean;
  tone?: "warn";
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-2.5 rounded-2xl border px-4 py-3.5 text-left text-sm font-medium transition active:scale-[0.98] disabled:opacity-50 ${
        tone === "warn" ? "border-warn/50 bg-warn-bg text-warn" : "border-line bg-panel"
      }`}
    >
      <span className={busy ? "animate-spin" : ""}>{icon}</span>
      {busy ? "Working…" : label}
    </button>
  );
}
