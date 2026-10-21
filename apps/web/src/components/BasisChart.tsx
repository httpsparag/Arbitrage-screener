"use client";

import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { getSupabase } from "@/lib/supabase";

const IST_OFFSET_S = 330 * 60;

/** Intraday basis (5-minute samples, last ~7 days) for one futures contract. */
export function BasisChart({ futToken }: { futToken: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<{ time: UTCTimestamp; value: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSupabase()
      .from("basis_history")
      .select("ts,basis_pct")
      .eq("fut_token", futToken)
      .order("ts", { ascending: true })
      .limit(3000)
      .then(({ data, error: e }) => {
        if (cancelled) return;
        if (e) setError(e.message);
        // Chart times are shifted to IST so the axis reads in exchange time.
        else
          setPoints(
            (data ?? []).map((d: { ts: string; basis_pct: number }) => ({
              time: (Math.floor(Date.parse(d.ts) / 1000) + IST_OFFSET_S) as UTCTimestamp,
              value: Number(d.basis_pct),
            })),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [futToken]);

  useEffect(() => {
    if (!el.current || !points || points.length < 2) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el.current, {
      height: 200,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--muted"), attributionLogo: false },
      grid: { vertLines: { color: v("--line") }, horzLines: { color: v("--line") } },
      rightPriceScale: { borderColor: v("--line") },
      timeScale: { borderColor: v("--line"), timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: (p: number) => `${p.toFixed(2)}%` },
    });
    const series = chart.addSeries(LineSeries, { color: v("--accent"), lineWidth: 2 });
    series.setData(points);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  if (error) return <p className="text-xs text-down">Could not load history: {error}</p>;
  if (!points) return <p className="text-xs text-muted">Loading…</p>;
  if (points.length < 2) {
    return (
      <p className="rounded-xl bg-panel-2 px-3 py-3 text-xs text-muted">
        No history yet. The worker records the basis every 5 minutes during market hours; the chart fills in from the first full session.
      </p>
    );
  }
  return (
    <div>
      <div ref={el} className="h-[200px] w-full" />
      <p className="mt-1 text-[11px] text-muted">
        5-minute samples, IST. Gaps are market closures. Past basis behaviour does not guarantee future convergence.
      </p>
    </div>
  );
}
