-- Prevent "Database error saving new user" by making profile creation resilient.
-- Safe to run multiple times.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists age integer;
alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists height integer;
alter table public.profiles add column if not exists weight integer;
alter table public.profiles add column if not exists activity text;
alter table public.profiles add column if not exists goal text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_email boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'email'
  ) into has_email;

  begin
    if has_email then
      insert into public.profiles (
        id,
        email,
        name,
        age,
        gender,
        height,
        weight,
        activity,
        goal
      )
      values (
        new.id,
        new.email,
        coalesce(
          nullif(new.raw_user_meta_data->>'name', ''),
          nullif(new.raw_user_meta_data->>'full_name', ''),
          split_part(coalesce(new.email, ''), '@', 1),
          'User'
        ),
        coalesce(nullif(new.raw_user_meta_data->>'age', '')::int, 28),
        coalesce(nullif(new.raw_user_meta_data->>'gender', ''), 'male'),
        coalesce(nullif(new.raw_user_meta_data->>'height', '')::int, 170),
        coalesce(nullif(new.raw_user_meta_data->>'weight', '')::int, 70),
        coalesce(nullif(new.raw_user_meta_data->>'activity', ''), 'moderate'),
        coalesce(nullif(new.raw_user_meta_data->>'goal', ''), 'loss')
      )
      on conflict (id) do update
        set email = excluded.email;
    else
      insert into public.profiles (
        id,
        name,
        age,
        gender,
        height,
        weight,
        activity,
        goal
      )
      values (
        new.id,
        coalesce(
          nullif(new.raw_user_meta_data->>'name', ''),
          nullif(new.raw_user_meta_data->>'full_name', ''),
          split_part(coalesce(new.email, ''), '@', 1),
          'User'
        ),
        coalesce(nullif(new.raw_user_meta_data->>'age', '')::int, 28),
        coalesce(nullif(new.raw_user_meta_data->>'gender', ''), 'male'),
        coalesce(nullif(new.raw_user_meta_data->>'height', '')::int, 170),
        coalesce(nullif(new.raw_user_meta_data->>'weight', '')::int, 70),
        coalesce(nullif(new.raw_user_meta_data->>'activity', ''), 'moderate'),
        coalesce(nullif(new.raw_user_meta_data->>'goal', ''), 'loss')
      )
      on conflict (id) do nothing;
    end if;
  exception when others then
    -- Never block auth.users signup if profile insert fails.
    raise warning 'handle_new_user profile upsert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill users created before the trigger fix.
do $$
declare
  has_email boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'email'
  ) into has_email;

  if has_email then
    insert into public.profiles (
      id,
      email,
      name,
      age,
      gender,
      height,
      weight,
      activity,
      goal
    )
    select
      u.id,
      u.email,
      coalesce(
        nullif(u.raw_user_meta_data->>'name', ''),
        nullif(u.raw_user_meta_data->>'full_name', ''),
        split_part(coalesce(u.email, ''), '@', 1),
        'User'
      ),
      coalesce(nullif(u.raw_user_meta_data->>'age', '')::int, 28),
      coalesce(nullif(u.raw_user_meta_data->>'gender', ''), 'male'),
      coalesce(nullif(u.raw_user_meta_data->>'height', '')::int, 170),
      coalesce(nullif(u.raw_user_meta_data->>'weight', '')::int, 70),
      coalesce(nullif(u.raw_user_meta_data->>'activity', ''), 'moderate'),
      coalesce(nullif(u.raw_user_meta_data->>'goal', ''), 'loss')
    from auth.users u
    where not exists (
      select 1
      from public.profiles p
      where p.id = u.id
    );
  else
    insert into public.profiles (
      id,
      name,
      age,
      gender,
      height,
      weight,
      activity,
      goal
    )
    select
      u.id,
      coalesce(
        nullif(u.raw_user_meta_data->>'name', ''),
        nullif(u.raw_user_meta_data->>'full_name', ''),
        split_part(coalesce(u.email, ''), '@', 1),
        'User'
      ),
      coalesce(nullif(u.raw_user_meta_data->>'age', '')::int, 28),
      coalesce(nullif(u.raw_user_meta_data->>'gender', ''), 'male'),
      coalesce(nullif(u.raw_user_meta_data->>'height', '')::int, 170),
      coalesce(nullif(u.raw_user_meta_data->>'weight', '')::int, 70),
      coalesce(nullif(u.raw_user_meta_data->>'activity', ''), 'moderate'),
      coalesce(nullif(u.raw_user_meta_data->>'goal', ''), 'loss')
    from auth.users u
    where not exists (
      select 1
      from public.profiles p
      where p.id = u.id
    );
  end if;
end
$$;
