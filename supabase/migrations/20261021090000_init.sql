-- NSE Cash–Futures Arbitrage Screener: initial schema.
-- Run once in Supabase Dashboard → SQL Editor → New query → paste → Run.
--
-- Market data tables are written only by the worker (service role, bypasses RLS) and are
-- readable by signed-in users. User tables are private to their owner.

-- ───────────────────────────── Market data (worker-written) ─────────────────────────────

create table if not exists public.contracts (
  fut_token            text primary key,
  symbol               text not null,
  name                 text not null,
  cash_token           text not null,
  cash_trading_symbol  text not null,
  fut_trading_symbol   text not null,
  expiry               date not null,
  lot_size             integer not null check (lot_size > 0),
  tick_size            numeric not null,
  status               text not null,
  updated_at           timestamptz not null default now()
);
create index if not exists contracts_symbol_idx on public.contracts (symbol, expiry);

-- Single-row feed health record; the dashboard derives LIVE/STALE/OFFLINE from heartbeat_at.
create table if not exists public.feed_status (
  id               integer primary key default 1 check (id = 1),
  provider         text,
  data_kind        text,
  state            text,
  last_message_at  timestamptz,
  last_tick_at     timestamptz,
  subscribed       integer,
  reconnects       integer,
  last_error       text,
  heartbeat_at     timestamptz,
  worker_version   text
);

-- Latest full compact scan, so a freshly opened page has data before the next broadcast.
create table if not exists public.screener_snapshot (
  id        integer primary key default 1 check (id = 1),
  taken_at  timestamptz not null,
  payload   jsonb not null
);

-- Intraday basis at 5-minute resolution (kept ~7 days by the worker).
create table if not exists public.basis_history (
  fut_token   text not null,
  ts          timestamptz not null,
  cash_price  numeric not null,
  fut_price   numeric not null,
  basis_pct   numeric not null,
  primary key (fut_token, ts)
);

-- One row per contract per trading day (kept long term for the 20/60-day charts).
create table if not exists public.basis_daily (
  fut_token        text not null,
  trade_date       date not null,
  symbol           text not null,
  expiry           date not null,
  close_basis_pct  numeric,
  avg_basis_pct    numeric,
  min_basis_pct    numeric,
  max_basis_pct    numeric,
  samples          integer not null default 0,
  primary key (fut_token, trade_date)
);
create index if not exists basis_daily_symbol_idx on public.basis_daily (symbol, trade_date);

create table if not exists public.session_summaries (
  trade_date  date primary key,
  summary     jsonb not null,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────── User data (owner-only) ─────────────────────────────

create table if not exists public.user_settings (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  calc_config  jsonb not null default '{}'::jsonb,
  ui_prefs     jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create table if not exists public.filter_presets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  filters      jsonb not null,
  rank_metric  text not null,
  created_at   timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.watchlist (
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol    text not null,
  added_at  timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table if not exists public.alert_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name              text not null,
  kind              text not null check (kind in (
                      'yield_above', 'profit_per_lot_above', 'turned_profitable',
                      'quote_stale', 'feed_down', 'contract_ineligible',
                      'liquidity_failed', 'spread_deteriorated')),
  threshold         numeric,
  symbol            text,
  enabled           boolean not null default true,
  cooldown_minutes  integer not null default 15 check (cooldown_minutes >= 0),
  created_at        timestamptz not null default now()
);

create table if not exists public.alert_events (
  id          bigint generated always as identity primary key,
  rule_id     uuid references public.alert_rules (id) on delete set null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  symbol      text,
  expiry      date,
  kind        text not null,
  message     text not null,
  payload     jsonb not null default '{}'::jsonb,
  read_at     timestamptz
);
create index if not exists alert_events_user_idx on public.alert_events (user_id, created_at desc);

-- ───────────────────────────── Row-level security ─────────────────────────────

alter table public.contracts          enable row level security;
alter table public.feed_status        enable row level security;
alter table public.screener_snapshot  enable row level security;
alter table public.basis_history      enable row level security;
alter table public.basis_daily        enable row level security;
alter table public.session_summaries  enable row level security;
alter table public.user_settings      enable row level security;
alter table public.filter_presets     enable row level security;
alter table public.watchlist          enable row level security;
alter table public.alert_rules        enable row level security;
alter table public.alert_events       enable row level security;

-- Market data: read-only for signed-in users.
create policy "signed-in read" on public.contracts         for select to authenticated using (true);
create policy "signed-in read" on public.feed_status       for select to authenticated using (true);
create policy "signed-in read" on public.screener_snapshot for select to authenticated using (true);
create policy "signed-in read" on public.basis_history     for select to authenticated using (true);
create policy "signed-in read" on public.basis_daily       for select to authenticated using (true);
create policy "signed-in read" on public.session_summaries for select to authenticated using (true);

-- User data: owner only.
create policy "owner all" on public.user_settings  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner all" on public.filter_presets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner all" on public.watchlist      for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner all" on public.alert_rules    for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner read/update" on public.alert_events for select to authenticated
  using (user_id = auth.uid());
create policy "owner mark read" on public.alert_events for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────────── Realtime ─────────────────────────────

-- Private broadcast channel "screener": only signed-in users may receive it.
create policy "signed-in receive screener broadcasts" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'screener');

-- Low-volume tables pushed to the page as database changes.
alter publication supabase_realtime add table public.alert_events;
alter publication supabase_realtime add table public.feed_status;
