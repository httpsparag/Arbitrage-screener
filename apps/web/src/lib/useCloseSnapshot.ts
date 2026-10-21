"use client";

// Latest end-of-day "closing prices" view, shown while the market is closed.

import { useCallback, useEffect, useState } from "react";
import type { WireMessage } from "@arb/core";
import { getSupabase } from "./supabase";

export interface CloseSnapshot {
  tradeDate: string;
  message: WireMessage;
}

export function useCloseSnapshot(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<CloseSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await getSupabase()
      .from("close_snapshots")
      .select("trade_date,payload")
      .order("trade_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e) setError(e.message);
    else if (data) {
      setSnapshot({ tradeDate: data.trade_date as string, message: data.payload as WireMessage });
      setError(null);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    run();
    // A new close snapshot appears once a day; checking every 5 minutes is plenty.
    const t = setInterval(run, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, load]);

  return { snapshot, error };
}
