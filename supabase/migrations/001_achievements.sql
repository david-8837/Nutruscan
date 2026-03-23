-- Run in Supabase SQL Editor if not applied via CLI
create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  achievement_id int not null check (achievement_id between 1 and 6),
  earned_at timestamptz not null default now(),
  unique (user_id, achievement_id)
);

alter table public.achievements enable row level security;

create policy "achievements_select_own"
  on public.achievements for select
  using (auth.uid() = user_id);

create policy "achievements_insert_own"
  on public.achievements for insert
  with check (auth.uid() = user_id);
