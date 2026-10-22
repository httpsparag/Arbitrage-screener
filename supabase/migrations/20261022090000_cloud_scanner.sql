-- Cloud scanner (no PC needed): Supabase Cron calls the `scan` Edge Function every minute in
-- market hours and `refresh-universe` once each morning. Secrets for the cron calls live in
-- Supabase Vault (set by `npm run fn:schedule`), never in this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ───────────── Scanner session (private: no client policies, service role only) ─────────────
create table if not exists public.scanner_session (
  id                   integer primary key default 1 check (id = 1),
  angel_jwt            text,
  angel_feed_token     text,
  angel_login_date     date,
  angel_login_at       timestamptz,
  lock_until           timestamptz,
  summary_written_for  date,
  close_written_for    date,
  last_basis_bucket    timestamptz
);
insert into public.scanner_session (id) values (1) on conflict do nothing;
alter table public.scanner_session enable row level security;

-- ───────────── Status shown on the phone ─────────────
create table if not exists public.scanner_status (
  id                      integer primary key default 1 check (id = 1),
  state                   text not null default 'idle',   -- running | idle | paused | error
  message                 text,
  phase                   text,
  last_run_at             timestamptz,
  last_ok_at              timestamptz,
  last_error              text,
  last_error_at           timestamptz,
  last_duration_ms        integer,
  quotes_fetched          integer,
  contracts               integer,
  margins_known           integer,
  universe_refreshed_at   timestamptz,
  poll_interval_ms        integer
);
insert into public.scanner_status (id) values (1) on conflict do nothing;
alter table public.scanner_status enable row level security;
create policy "signed-in read" on public.scanner_status for select to authenticated using (true);

-- ───────────── Controls the phone can change ─────────────
create table if not exists public.scanner_control (
  id              integer primary key default 1 check (id = 1),
  paused_until    date,            -- skip scanning up to and including this date
  force_relogin   boolean not null default false,
  updated_at      timestamptz not null default now()
);
insert into public.scanner_control (id) values (1) on conflict do nothing;
alter table public.scanner_control enable row level security;
create policy "signed-in read" on public.scanner_control for select to authenticated using (true);
create policy "signed-in update" on public.scanner_control for update to authenticated using (true) with check (true);

-- ───────────── Broker margins (fraction of futures value) ─────────────
create table if not exists public.contract_margins (
  fut_token   text primary key,
  rate        numeric not null check (rate > 0 and rate < 1),
  fetched_at  timestamptz not null default now()
);
alter table public.contract_margins enable row level security;
create policy "signed-in read" on public.contract_margins for select to authenticated using (true);

-- ───────────── Helpers for the scanner (service role only) ─────────────

-- Prevents overlapping runs: returns true and takes the lock if it is free or expired.
create or replace function public.scanner_try_lock(seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare got boolean;
begin
  update scanner_session
     set lock_until = now() + make_interval(secs => seconds)
   where id = 1 and (lock_until is null or lock_until < now())
  returning true into got;
  return coalesce(got, false);
end;
$$;

create or replace function public.scanner_unlock()
returns void
language sql
security definer
set search_path = public
as $$ update scanner_session set lock_until = null where id = 1; $$;

-- Daily basis statistics from the 5-minute samples of one IST trading day.
create or replace function public.rollup_basis_daily(trade_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into basis_daily (fut_token, trade_date, symbol, expiry, close_basis_pct, avg_basis_pct, min_basis_pct, max_basis_pct, samples)
  select h.fut_token, trade_day, c.symbol, c.expiry,
         (array_agg(h.basis_pct order by h.ts desc))[1],
         avg(h.basis_pct), min(h.basis_pct), max(h.basis_pct), count(*)
    from basis_history h
    join contracts c on c.fut_token = h.fut_token
   where (h.ts at time zone 'Asia/Kolkata')::date = trade_day
   group by h.fut_token, c.symbol, c.expiry
  on conflict (fut_token, trade_date) do update
     set close_basis_pct = excluded.close_basis_pct,
         avg_basis_pct   = excluded.avg_basis_pct,
         min_basis_pct   = excluded.min_basis_pct,
         max_basis_pct   = excluded.max_basis_pct,
         samples         = excluded.samples;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.scanner_try_lock(integer) from public, anon, authenticated;
revoke all on function public.scanner_unlock() from public, anon, authenticated;
revoke all on function public.rollup_basis_daily(date) from public, anon, authenticated;

-- Phones listen for status changes.
alter publication supabase_realtime add table public.scanner_status;

-- ───────────── Schedules (UTC; IST = UTC+5:30) ─────────────
-- Calls an Edge Function with the scan key stored in Vault.
create or replace function public.call_scanner_function(fn text)
returns bigint
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'arb_project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scan-key', (select decrypted_secret from vault.decrypted_secrets where name = 'arb_scan_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$;
revoke all on function public.call_scanner_function(text) from public, anon, authenticated;

-- Contract list + lot sizes: 08:30 IST on weekdays.
select cron.schedule('arb-refresh-universe', '0 3 * * 1-5', $$ select public.call_scanner_function('refresh-universe') $$);
-- Scan: every minute 08:30–16:29 IST on weekdays (the function itself only works 08:45–15:50).
select cron.schedule('arb-scan', '* 3-10 * * 1-5', $$ select public.call_scanner_function('scan') $$);
