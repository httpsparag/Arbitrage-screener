"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm rounded-[28px] border border-line bg-panel p-6 shadow-2xl">
        <div className="brand-mark h-11 w-11 rounded-2xl" aria-hidden />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Arb Screener</h1>
        <p className="mt-1 text-sm text-muted">Find stocks where buying the share and selling its future locks in a profit after all charges.</p>
        <label className="mt-6 block text-xs font-medium text-muted" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-line bg-panel-2 px-4 py-3 text-base outline-none focus:border-accent"
        />
        <label className="mt-4 block text-xs font-medium text-muted" htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-line bg-panel-2 px-4 py-3 text-base outline-none focus:border-accent"
        />
        {error && <p className="mt-3 rounded-lg bg-down-bg px-3 py-2 text-sm text-down" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-accent px-3 py-3.5 text-[15px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
