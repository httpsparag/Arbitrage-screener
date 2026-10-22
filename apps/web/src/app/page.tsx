"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import { Dashboard } from "@/components/Dashboard";
import { Login } from "@/components/Login";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";

const noopSubscribe = () => () => {};

export default function Home() {
  // false during server render and hydration, true afterwards: the app is client-only.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured()) return;
    const supabase = getSupabase();
    // A broken or expired stored session must not leave the app on "Loading…" forever:
    // on error, or no answer within 8 s, fall back to the login screen.
    const fallback = setTimeout(() => setChecking(false), 8000);
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null))
      .finally(() => {
        clearTimeout(fallback);
        setChecking(false);
      });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setChecking(false);
    });
    return () => {
      clearTimeout(fallback);
      data.subscription.unsubscribe();
    };
  }, []);

  if (!mounted || checking) {
    return <div className="flex flex-1 items-center justify-center text-muted text-sm">Loading…</div>;
  }
  if (!supabaseConfigured()) {
    return (
      <div className="m-auto max-w-md p-6 text-sm">
        <h1 className="mb-2 text-lg font-semibold">Setup needed</h1>
        <p className="text-muted">
          Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to{" "}
          <code>apps/web/.env.local</code> (or the Vercel project settings) and restart.
        </p>
      </div>
    );
  }
  return session ? <Dashboard session={session} /> : <Login />;
}
