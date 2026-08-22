-- Commonplace — run this once in the Supabase SQL Editor (Database > SQL Editor > New query).
-- Creates the entries table (your actual notes/todos/etc.) and a settings table (tag colors,
-- custom tabs, drag-reorder positions), both locked down so only your logged-in account can
-- read or write its own rows.

create table if not exists entries (
  id text primary key,
  user_id uuid not null references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  type text not null,
  title text default '',
  body text default '',
  tags text[] default '{}',
  due_at date,
  done boolean default false,
  done_at timestamptz,
  pinned boolean default false,
  source text default 'manual',
  weekly_target integer,
  checkins date[]
);

alter table entries enable row level security;

create policy "entries: owner read/write" on entries
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists settings (
  user_id uuid primary key references auth.users(id) default auth.uid(),
  tag_colors jsonb default '{}',
  views jsonb default '[]',
  nav_order jsonb default '[]',
  board_order jsonb default '[]'
);

alter table settings enable row level security;

create policy "settings: owner read/write" on settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- realtime so edits on one device show up on another without a manual refresh
alter publication supabase_realtime add table entries;
