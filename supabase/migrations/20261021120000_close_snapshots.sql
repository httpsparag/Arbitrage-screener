-- End-of-day view: every contract calculated from the session's closing prices.
-- Written by the worker after the derivatives close (or by `npm run close:snapshot`).

create table if not exists public.close_snapshots (
  trade_date  date primary key,
  taken_at    timestamptz not null,
  payload     jsonb not null
);

alter table public.close_snapshots enable row level security;

create policy "signed-in read" on public.close_snapshots for select to authenticated using (true);
