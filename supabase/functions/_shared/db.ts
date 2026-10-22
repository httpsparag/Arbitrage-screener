// Service-role Supabase client and request authorization for scanner functions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

export const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("ARB_SERVICE_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Accepts the scheduler (x-scan-key header) or a signed-in dashboard user (Bearer token).
 * Returns who called, or null when unauthorized.
 */
export async function authorize(req: Request, db: SupabaseClient): Promise<"cron" | "user" | null> {
  const scanKey = env("SCAN_KEY");
  if (scanKey && req.headers.get("x-scan-key") === scanKey) return "cron";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  const { data, error } = await db.auth.getUser(bearer);
  return !error && data.user ? "user" : null;
}

export async function check<T>(label: string, p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
