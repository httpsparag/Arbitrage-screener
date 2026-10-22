"use client";

// Cloud scanner status and controls (Settings → Control panel).

import { useCallback, useEffect, useState } from "react";
import { istDate } from "@arb/core";
import { getSupabase } from "./supabase";

export interface ScannerStatus {
  state: "running" | "idle" | "paused" | "error" | string;
  message: string | null;
  phase: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_duration_ms: number | null;
  quotes_fetched: number | null;
  contracts: number | null;
  margins_known: number | null;
  universe_refreshed_at: string | null;
  poll_interval_ms: number | null;
}

export interface ScannerControl {
  paused_until: string | null;
  force_relogin: boolean;
}

export type ScannerAction = "scan" | "close" | "relogin" | "refresh-universe";

/** `today` is the current IST date (YYYY-MM-DD), passed in so rendering stays pure. */
export function useScanner(enabled: boolean, today: string) {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [control, setControl] = useState<ScannerControl | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const [s, c] = await Promise.all([
      supabase.from("scanner_status").select("*").eq("id", 1).maybeSingle(),
      supabase.from("scanner_control").select("paused_until,force_relogin").eq("id", 1).maybeSingle(),
    ]);
    if (s.data) setStatus(s.data as ScannerStatus);
    if (c.data) setControl(c.data as ScannerControl);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabase();
    const first = setTimeout(() => void load(), 0);
    const ch = supabase
      .channel("scanner-status")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "scanner_status" }, (p) => setStatus(p.new as ScannerStatus))
      .subscribe();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      void supabase.removeChannel(ch);
    };
  }, [enabled, load]);

  const run = useCallback(
    async (action: ScannerAction, label: string) => {
      setBusy(action);
      setNote(null);
      const fn = action === "refresh-universe" ? "refresh-universe" : "scan";
      const { error } = await getSupabase().functions.invoke(fn, { body: fn === "scan" ? { action, manual: true } : {} });
      setBusy(null);
      setNote(error ? { ok: false, text: `${label} failed: ${error.message}` } : { ok: true, text: `${label} started — status updates in a few seconds.` });
      setTimeout(() => void load(), 4000);
      setTimeout(() => void load(), 15000);
    },
    [load],
  );

  const setPaused = useCallback(
    async (pause: boolean) => {
      setBusy("pause");
      const paused_until = pause ? istDate(Date.now()) : null;
      const { error } = await getSupabase()
        .from("scanner_control")
        .update({ paused_until, updated_at: new Date().toISOString() })
        .eq("id", 1);
      setBusy(null);
      setNote(error ? { ok: false, text: error.message } : { ok: true, text: pause ? "Paused for the rest of today." : "Resumed — scanning restarts within a minute." });
      void load();
    },
    [load],
  );

  const pausedToday = !!control?.paused_until && control.paused_until >= today;
  return { status, control, busy, note, run, setPaused, pausedToday, reload: load };
}
