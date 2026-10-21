"use client";

// Live screener data: loads the latest full snapshot, then merges the worker's
// 5-second "top" broadcasts from the private realtime channel.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WireFeed, WireMessage, WireRow, WireSummary } from "@arb/core";
import { getSupabase } from "./supabase";

export interface RowState {
  row: WireRow;
  /** Worker time of the message that last carried this row. */
  at: number;
}

export type ChannelState = "connecting" | "subscribed" | "error" | "closed";

export interface ScreenerData {
  rows: Map<string, RowState>;
  feed: WireFeed | null;
  summary: WireSummary | null;
  settings: Record<string, unknown>;
  /** Worker time of the newest message of any kind. */
  lastMessageAt: number | null;
  lastFullAt: number | null;
  channel: ChannelState;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useScreener(enabled: boolean): ScreenerData {
  const [rows, setRows] = useState<Map<string, RowState>>(new Map());
  const [feed, setFeed] = useState<WireFeed | null>(null);
  const [summary, setSummary] = useState<WireSummary | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [lastFullAt, setLastFullAt] = useState<number | null>(null);
  const [channel, setChannel] = useState<ChannelState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const newest = useRef(0);

  const applyMessage = useCallback((msg: WireMessage) => {
    if (msg.at < newest.current && msg.kind === "top") return; // out-of-order
    newest.current = Math.max(newest.current, msg.at);
    setFeed(msg.feed);
    setSummary(msg.summary);
    setSettings(msg.settings ?? {});
    setLastMessageAt((t) => Math.max(t ?? 0, msg.at));
    setRows((prev) => {
      if (msg.kind === "full") {
        const next = new Map<string, RowState>();
        for (const r of msg.rows) {
          const old = prev.get(r.k);
          // Keep a fresher row from a later "top" broadcast.
          next.set(r.k, old && old.at > msg.at ? old : { row: r, at: msg.at });
        }
        return next;
      }
      const next = new Map(prev);
      for (const r of msg.rows) next.set(r.k, { row: r, at: msg.at });
      return next;
    });
    if (msg.kind === "full") setLastFullAt(msg.at);
  }, []);

  const refresh = useCallback(async () => {
    const { data, error: e } = await getSupabase()
      .from("screener_snapshot")
      .select("payload")
      .eq("id", 1)
      .maybeSingle();
    if (e) {
      setError(`Snapshot: ${e.message}`);
      return;
    }
    if (data?.payload) applyMessage({ ...(data.payload as WireMessage), kind: "full" });
    setError(null);
  }, [applyMessage]);

  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabase();
    let cancelled = false;
    let ch: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      await refresh();
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      ch = supabase
        .channel("screener", { config: { private: true } })
        .on("broadcast", { event: "top" }, ({ payload }) => applyMessage(payload as WireMessage))
        .on("broadcast", { event: "snapshot" }, ({ payload }) => {
          const p = payload as Pick<WireMessage, "at" | "feed" | "summary">;
          setFeed(p.feed);
          setSummary(p.summary);
          setLastMessageAt((t) => Math.max(t ?? 0, p.at));
          void refresh();
        })
        .subscribe((status, err) => {
          if (status === "SUBSCRIBED") setChannel("subscribed");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setChannel("error");
            setError(err?.message ?? `Realtime ${status.toLowerCase()}`);
          } else if (status === "CLOSED") setChannel("closed");
        });
    })();

    // Phones suspend background tabs: catch up when the page becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (ch) void supabase.removeChannel(ch);
    };
  }, [enabled, refresh, applyMessage]);

  return { rows, feed, summary, settings, lastMessageAt, lastFullAt, channel, error, refresh };
}

/** Ticks every `ms` so "x seconds ago" labels and freshness badges stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
