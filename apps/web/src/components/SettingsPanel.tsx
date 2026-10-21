"use client";

import { useState } from "react";
import { BookOpen, LogOut, ShieldCheck } from "lucide-react";
import { sanitizeSettings, type UserCalcSettings } from "@arb/core";

export function SettingsPanel({
  email,
  settings,
  workerSettings,
  onSave,
  onSignOut,
  onHelp,
}: {
  email: string | undefined;
  settings: UserCalcSettings;
  workerSettings: Record<string, unknown>;
  onSave: (s: UserCalcSettings) => Promise<string | null>;
  onSignOut: () => void;
  onHelp: () => void;
}) {
  const [draft, setDraft] = useState<UserCalcSettings>({
    fundingRatePct: 7,
    lots: 1,
    profitBasis: "before_funding",
    exitMode: "square_off",
    exitSlippageBps: 0,
    mtmBufferPct: 0,
    fallbackMarginPct: 20,
    pledgeShares: false,
    ...settings,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<UserCalcSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setMsg(null);
  };
  const dirty = JSON.stringify(sanitizeSettings(draft)) !== JSON.stringify(sanitizeSettings({ ...settings }));
  const workerBehind = JSON.stringify(sanitizeSettings(workerSettings)) !== JSON.stringify(sanitizeSettings(settings));

  async function save() {
    setBusy(true);
    const err = await onSave(draft);
    setBusy(false);
    setMsg(err ? { ok: false, text: err } : { ok: true, text: "Saved. The list updates with these settings within about a minute." });
  }

  const numIn = (key: keyof UserCalcSettings, min: number, max: number, step: number, suffix: string) => (
    <div className="flex items-center gap-2">
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={(draft[key] as number | undefined) ?? ""}
        onChange={(e) => set({ [key]: e.target.value === "" ? undefined : Number(e.target.value) } as Partial<UserCalcSettings>)}
        className="num w-24 rounded-xl border border-line bg-panel-2 px-3 py-2 text-right text-base outline-none focus:border-accent"
      />
      <span className="w-10 text-sm text-muted">{suffix}</span>
    </div>
  );

  return (
    <div className="space-y-6 pb-4">
      <Group title="Returns">
        <Row label="My funding rate" hint="What your money earns elsewhere (FD, liquid fund) or your loan rate.">
          {numIn("fundingRatePct", 0, 50, 0.25, "% / yr")}
        </Row>
        <Row label="Count as profitable when…">
          <select
            value={draft.profitBasis}
            onChange={(e) => set({ profitBasis: e.target.value as UserCalcSettings["profitBasis"] })}
            className="max-w-[11rem] rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm"
          >
            <option value="before_funding">Positive after costs</option>
            <option value="after_funding">Beats my funding rate</option>
          </select>
        </Row>
      </Group>

      <Group title="Trade size">
        <Row label="Lots per trade" hint="All profit and capital figures are for this many lots.">
          {numIn("lots", 1, 100, 1, "lots")}
        </Row>
        <Row label="How the trade ends">
          <select
            value={draft.exitMode}
            onChange={(e) => set({ exitMode: e.target.value as UserCalcSettings["exitMode"] })}
            className="max-w-[11rem] rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm"
          >
            <option value="square_off">Sell both at expiry</option>
            <option value="physical_settlement">Deliver shares at expiry</option>
          </select>
        </Row>
      </Group>

      <Group title="Money needed">
        <Row label="Safety buffer" hint="Extra cash for daily losses on the futures side if the price rises. 0 = none.">
          {numIn("mtmBufferPct", 0, 50, 0.5, "%")}
        </Row>
        <Row label="Pledge the shares" hint="Use the bought shares (after a 20% haircut) to cover up to half the margin.">
          <Toggle checked={!!draft.pledgeShares} onChange={(v) => set({ pledgeShares: v })} label="Pledge the shares" />
        </Row>
        <Row label="Fallback margin" hint="Only used if Angel One's margin for a contract is unavailable.">
          {numIn("fallbackMarginPct", 5, 100, 1, "%")}
        </Row>
      </Group>

      <Group title="Advanced">
        <Row label="Exit slippage" hint="Cushion for not exiting exactly at the expiry price (per side).">
          {numIn("exitSlippageBps", 0, 100, 1, "bps")}
        </Row>
      </Group>

      {workerBehind && !dirty && !msg && (
        <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
          Your latest settings reach the live list within about a minute while the worker is running.
        </p>
      )}
      {msg && (
        <p className={`rounded-2xl px-4 py-3 text-sm ${msg.ok ? "bg-up-bg text-up" : "bg-down-bg text-down"}`} role="status">
          {msg.text}
        </p>
      )}
      <button
        onClick={save}
        disabled={busy || !dirty}
        className="w-full rounded-2xl bg-accent px-4 py-3.5 text-[15px] font-semibold text-white transition disabled:opacity-40"
      >
        {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
      </button>

      <Group title="About">
        <button onClick={onHelp} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
          <BookOpen size={18} className="text-muted" />
          <span className="flex-1 text-[15px]">How it works & glossary</span>
        </button>
        <div className="flex items-start gap-3 px-4 py-3.5">
          <ShieldCheck size={18} className="mt-0.5 text-muted" />
          <p className="flex-1 text-sm text-muted">
            Prices from Angel One SmartAPI. Charges use the current NSE schedule (STT, exchange, SEBI, stamp duty, GST)
            and an estimated Angel One brokerage profile. Estimates only — not investment advice.
          </p>
        </div>
        <button onClick={onSignOut} className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-down">
          <LogOut size={18} />
          <span className="flex-1 text-[15px]">Sign out</span>
          <span className="truncate text-xs text-muted">{email}</span>
        </button>
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-panel">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[15px]">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-snug text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}
