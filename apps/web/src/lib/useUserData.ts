"use client";

// The signed-in user's calculation settings and watchlist (owner-only tables).

import { useCallback, useEffect, useState } from "react";
import { sanitizeSettings, type UserCalcSettings } from "@arb/core";
import { getSupabase } from "./supabase";

export function useUserData(userId: string | null) {
  const [settings, setSettings] = useState<UserCalcSettings>({});
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    (async () => {
      const [s, w] = await Promise.all([
        supabase.from("user_settings").select("calc_config").eq("user_id", userId).maybeSingle(),
        supabase.from("watchlist").select("symbol").eq("user_id", userId),
      ]);
      setSettings(sanitizeSettings(s.data?.calc_config ?? {}));
      setWatchlist(new Set((w.data ?? []).map((r: { symbol: string }) => r.symbol)));
      setLoaded(true);
    })();
  }, [userId]);

  const saveSettings = useCallback(
    async (next: UserCalcSettings) => {
      if (!userId) return "Not signed in";
      const clean = sanitizeSettings(next);
      const { error } = await getSupabase()
        .from("user_settings")
        .upsert({ user_id: userId, calc_config: clean, updated_at: new Date().toISOString() });
      if (error) return error.message;
      setSettings(clean);
      return null;
    },
    [userId],
  );

  const toggleWatch = useCallback(
    async (symbol: string) => {
      if (!userId) return;
      const supabase = getSupabase();
      const has = watchlist.has(symbol);
      setWatchlist((prev) => {
        const next = new Set(prev);
        if (has) next.delete(symbol);
        else next.add(symbol);
        return next;
      });
      const { error } = has
        ? await supabase.from("watchlist").delete().eq("user_id", userId).eq("symbol", symbol)
        : await supabase.from("watchlist").insert({ user_id: userId, symbol });
      if (error) {
        // Roll back the optimistic change.
        setWatchlist((prev) => {
          const next = new Set(prev);
          if (has) next.add(symbol);
          else next.delete(symbol);
          return next;
        });
      }
    },
    [userId, watchlist],
  );

  return { settings, saveSettings, watchlist, toggleWatch, loaded };
}
