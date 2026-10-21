"use client";

import { useMemo } from "react";
import { Activity, CircleAlert, CircleCheck, Coins, LineChart, ReceiptText, Star, Wallet } from "lucide-react";
import {
  applySettings,
  computeOpportunity,
  fromWireRow,
  type CostComponent,
  type UserCalcSettings,
} from "@arb/core";
import { ago, compactRupees, expiryLabel, istTime, num, pct, rupees } from "@/lib/format";
import type { RowState } from "@/lib/useScreener";
import { REASON_LABEL } from "@/lib/view";
import { BasisChart } from "./BasisChart";
import { StatusBadge } from "./OpportunityList";
import { Disclosure, Explain, Sheet } from "./ui";

const COMPONENT_LABEL: Record<CostComponent, string> = {
  brokerage: "Brokerage (est.)",
  stt: "STT (securities tax)",
  exchange: "Exchange charges",
  sebi: "SEBI fee",
  ipft: "Investor protection fee",
  stamp: "Stamp duty",
  dp: "Depository charge (est.)",
  gst: "GST",
  slippage: "Exit slippage (est.)",
};

const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v > 0 ? "text-up" : v < 0 ? "text-down" : "";

export function DetailSheet({
  state,
  settingsRaw,
  now,
  closeMode = false,
  stale,
  watched,
  onStar,
  onClose,
}: {
  state: RowState;
  settingsRaw: Record<string, unknown>;
  now: number;
  /** Row comes from the closing-prices view (last traded prices, theoretical). */
  closeMode?: boolean;
  stale: boolean;
  watched: boolean;
  onStar: () => void;
  onClose: () => void;
}) {
  const r = state.row;

  // Recompute the full breakdown with the same engine and the settings the worker used.
  const opp = useMemo(() => {
    const inputs = fromWireRow(r, state.at);
    const config = {
      ...applySettings(settingsRaw as UserCalcSettings),
      staleAfterMs: Number.MAX_SAFE_INTEGER,
      ...(closeMode ? { priceMode: "ltp" as const } : {}),
    };
    return computeOpportunity({ ...inputs, now: state.at, config, marketOpen: true, marginRate: inputs.marginRate });
  }, [r, state.at, settingsRaw, closeMode]);
  const e = opp.economics;
  const fundingPct = opp.assumptions.fundingRateBlended * 100;

  const costRows = useMemo(() => {
    if (!e) return [];
    const by = new Map<CostComponent, { cash: number; futures: number }>();
    for (const i of e.costs.items) {
      const v = by.get(i.component) ?? { cash: 0, futures: 0 };
      v[i.leg] += i.amount;
      by.set(i.component, v);
    }
    return [...by.entries()].sort((a, b) => b[1].cash + b[1].futures - (a[1].cash + a[1].futures));
  }, [e]);

  const executableNow = r.st === "executable" && !stale && !closeMode;
  const banner = closeMode
    ? { cls: "bg-warn-bg text-warn", icon: <CircleAlert size={18} />, title: "Closing prices — for review only", body: `Calculated from the day's closing prices (captured ${istTime(state.at)} IST). Cannot be traded at these prices.` }
    : stale
      ? { cls: "bg-warn-bg text-warn", icon: <CircleAlert size={18} />, title: "Prices are old", body: "This row has not been refreshed recently; don't act on it." }
      : r.st === "executable"
        ? { cls: "bg-up-bg text-up", icon: <CircleCheck size={18} />, title: "Profitable at current prices", body: `Based on live prices ${ago(now - state.at)}. Check prices in your broker app before trading.` }
        : r.st === "unprofitable"
          ? { cls: "bg-down-bg text-down", icon: <CircleAlert size={18} />, title: "Charges are bigger than the gap", body: "At current prices this trade would lose money after all charges." }
          : { cls: "bg-panel-2 text-muted", icon: <CircleAlert size={18} />, title: "Not usable right now", body: r.x.map((x) => REASON_LABEL[x]).join(" · ") || "Missing data." };

  return (
    <Sheet
      side
      label={`${r.s} details`}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {r.s}
          <StatusBadge row={r} stale={stale} closeMode={closeMode} />
        </span>
      }
      subtitle={`${expiryLabel(r.e)} expiry · ${r.d === 0 ? "expires today" : `${r.d} days left`} · lot ${num(r.l, 0)} shares`}
      footer={
        <button
          onClick={onStar}
          className={`flex w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
            watched ? "border-warn/50 bg-warn-bg text-warn" : "border-line bg-panel text-text"
          }`}
          aria-pressed={watched}
        >
          <Star size={18} fill={watched ? "currentColor" : "none"} />
          {watched ? "In your watchlist" : "Add to watchlist"}
        </button>
      }
    >
      <div className="space-y-4">
        {/* Status */}
        <div className={`flex gap-3 rounded-2xl px-4 py-3 ${banner.cls}`}>
          <span className="mt-0.5 shrink-0">{banner.icon}</span>
          <div>
            <p className="text-sm font-semibold">{banner.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed opacity-90">{banner.body}</p>
          </div>
        </div>

        {e ? (
          <>
            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-3xl border border-line bg-panel p-4">
                <p className="flex items-center gap-1 text-xs text-muted">Profit per lot <Explain term="netPerLot" /></p>
                <p className={`num mt-1 text-2xl font-semibold tracking-tight ${tone(e.netProfitPerLotBeforeFunding)}`}>
                  {rupees(e.netProfitPerLotBeforeFunding)}
                </p>
                <p className="mt-0.5 text-xs text-muted">after all charges</p>
              </div>
              <div className="rounded-3xl border border-line bg-panel p-4">
                <p className="flex items-center gap-1 text-xs text-muted">Yield a year <Explain term="yield" /></p>
                <p className={`num mt-1 text-2xl font-semibold tracking-tight ${tone(e.annualizedYieldBeforeFundingPct)}`}>
                  {pct(e.annualizedYieldBeforeFundingPct)}
                </p>
                <p className={`mt-0.5 text-xs ${tone(e.annualizedYieldPct)}`}>
                  {e.annualizedYieldPct === null ? "—" : `${pct(e.annualizedYieldPct, 2, true)} vs ${num(fundingPct, 0)}% rate`}
                </p>
              </div>
            </div>

            {/* The trade, step by step */}
            <section className="rounded-3xl border border-line bg-panel p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
                The trade <Explain term="strategy" />
              </h3>
              <ol className="space-y-3">
                <Step n={1} title={`${closeMode ? "Stock closed at" : "Buy"} ${num(e.quantity, 0)} shares at ₹${num(e.cashBuyPrice)}`} detail={`You pay ${rupees(e.cashValue)}`} />
                <Step
                  n={2}
                  title={`${closeMode ? "Future closed at" : "Sell"} ${e.lots} lot ${r.fs} at ₹${num(e.futSellPrice)}`}
                  detail={`Locks in a gap of ₹${num(e.grossSpread)} a share (${pct(e.grossSpreadPct, 2)}) = ${rupees(e.grossSpreadValueTotal)}`}
                />
                <Step n={3} title={`Hold ${e.holdingDays} days until ${expiryLabel(r.e)}`} detail="On expiry the two prices meet, so market moves cancel out." />
                <Step
                  n={4}
                  title={`Keep ${rupees(e.netProfitBeforeFunding)}`}
                  detail={`${rupees(e.grossSpreadValueTotal)} gap − ${rupees(e.costs.total)} charges${e.dividendIncome ? ` + ${rupees(e.dividendIncome)} dividend` : ""}`}
                  strong
                />
              </ol>
              <GapBar gross={e.grossSpreadValueTotal} costs={e.costs.total} />
            </section>

            {/* Money needed */}
            <section className="rounded-3xl border border-line bg-panel p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-muted"><Wallet size={18} /></span>
                <div className="flex-1">
                  <p className="flex items-center gap-1 text-sm font-semibold">Money needed <Explain term="capital" /></p>
                  <p className="num mt-1 text-2xl font-semibold tracking-tight">{rupees(e.capitalRequired)}</p>
                  <p className={`num text-xs ${tone(e.annualizedYieldOnCapitalPct)}`}>
                    {pct(e.annualizedYieldOnCapitalPct)} a year on this money
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                <Line k="Shares (paid in full)" v={rupees(e.cashValue)} />
                <Line k="Entry charges" v={rupees(e.entryCosts)} />
                <Line
                  k={`Futures margin · ${e.marginSource === "broker" ? "Angel One" : "estimate"} ${pct(e.marginRateUsed * 100, 1)}`}
                  v={rupees(e.marginEstimate)}
                />
                {e.collateralCredit > 0 && <Line k="Covered by pledged shares" v={rupees(-e.collateralCredit)} />}
                {e.mtmBuffer > 0 && <Line k="Safety buffer" v={rupees(e.mtmBuffer)} />}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted">
                The margin is returned when the trade closes. If the future rises before expiry, its daily loss is debited in cash
                while the matching gain on your shares stays unrealised — a safety buffer (Settings) covers this.
              </p>
            </section>

            <Disclosure title="All charges" icon={<ReceiptText size={18} />} aside={rupees(e.costs.total)}>
              <table className="num w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="pb-1 text-left font-medium">Charge</th>
                    <th className="pb-1 text-right font-medium">Stock</th>
                    <th className="pb-1 text-right font-medium">Future</th>
                  </tr>
                </thead>
                <tbody>
                  {costRows.map(([c, v]) => (
                    <tr key={c} className="border-t border-line">
                      <td className="py-1.5">{COMPONENT_LABEL[c]}</td>
                      <td className="text-right">{num(v.cash)}</td>
                      <td className="text-right">{num(v.futures)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line font-semibold">
                    <td className="py-1.5">Total {rupees(e.costs.total)}</td>
                    <td className="text-right">{num(e.costs.byLeg.cash)}</td>
                    <td className="text-right">{num(e.costs.byLeg.futures)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted">
                Entry {rupees(e.costs.byPhase.entry)} + exit {rupees(e.costs.byPhase.exit)} ·{" "}
                {opp.exitMode === "square_off" ? "both sides sold at expiry" : "shares delivered at expiry"} · {e.costs.scheduleId}
              </p>
            </Disclosure>
          </>
        ) : null}

        <Disclosure title={closeMode ? "Closing prices" : "Live prices"} icon={<Activity size={18} />} defaultOpen={!e}>
          <div className="grid grid-cols-2 gap-3">
            <QuoteBox
              title="Stock"
              rows={[
                ["Last", num(r.c[0])],
                ["Buyers (bid)", `${num(r.c[1])}`],
                ["Sellers (ask)", `${num(r.c[3])}`],
                ["Spread", pct(opp.quotes.cashSpreadPct, 3)],
                ["Turnover", compactRupees(r.c[5])],
              ]}
            />
            <QuoteBox
              title="Future"
              rows={[
                ["Last", num(r.f[0])],
                ["Buyers (bid)", `${num(r.f[1])}`],
                ["Sellers (ask)", `${num(r.f[3])}`],
                ["Spread", pct(opp.quotes.futSpreadPct, 3)],
                ["Open interest", num(r.f[6], 0)],
              ]}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted">Captured {istTime(state.at)} IST · quality {num(r.m[9], 0)}/100 <Explain term="quality" className="align-middle" /></p>
        </Disclosure>

        <Disclosure title="Price gap history" icon={<LineChart size={18} />}>
          <BasisChart futToken={r.k} />
        </Disclosure>

        <Disclosure title="Assumptions & notes" icon={<Coins size={18} />}>
          <div className="space-y-1.5">
            <Line k="Prices used" v={opp.priceMode === "bidask" ? "Best bid / ask" : "Closing (last traded)"} />
            <Line k="Lots" v={String(opp.assumptions.lots)} />
            <Line k="Funding rate" v={`${pct(fundingPct)} a year`} />
            {e && <Line k="Funding cost for this trade" v={rupees(e.fundingCost)} />}
            {e && <Line k="Profit after funding" v={rupees(e.netProfit)} />}
            <Line k="Charges schedule" v={opp.assumptions.scheduleId} />
          </div>
          {opp.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
              {opp.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}
          {executableNow && (
            <p className="mt-3 text-[11px] text-muted">Estimates only. Orders may fill at different prices; verify in your broker app.</p>
          )}
        </Disclosure>
      </div>
    </Sheet>
  );
}

function Step({ n, title, detail, strong = false }: { n: number; title: string; detail: string; strong?: boolean }) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          strong ? "bg-up-bg text-up" : "bg-panel-2 text-muted"
        }`}
      >
        {n}
      </span>
      <div className="min-w-0">
        <p className={`num text-sm ${strong ? "font-semibold" : "font-medium"}`}>{title}</p>
        <p className="num text-xs text-muted">{detail}</p>
      </div>
    </li>
  );
}

/** Visual split of the gap into charges and what you keep. */
function GapBar({ gross, costs }: { gross: number; costs: number }) {
  if (!(gross > 0)) return null;
  const costShare = Math.min(1, costs / gross);
  return (
    <div className="mt-4">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-panel-2" aria-hidden>
        <div className="bg-down/80" style={{ width: `${costShare * 100}%` }} />
        <div className="bg-up" style={{ width: `${(1 - costShare) * 100}%` }} />
      </div>
      <p className="num mt-1.5 flex justify-between text-[11px] text-muted">
        <span>Charges take {pct(costShare * 100, 0)} of the gap</span>
        <span>{costShare >= 1 ? "nothing left" : `you keep ${pct((1 - costShare) * 100, 0)}`}</span>
      </p>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="num flex justify-between gap-3 text-sm">
      <span className="text-muted">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

function QuoteBox({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-2xl bg-panel-2 p-3">
      <p className="mb-1.5 text-xs font-semibold">{title}</p>
      {rows.map(([k, v]) => (
        <div key={k} className="num flex justify-between gap-2 py-0.5 text-xs">
          <span className="text-muted">{k}</span>
          <span className="text-right">{v}</span>
        </div>
      ))}
    </div>
  );
}
