-- Enforce avatar update cooldown server-side and timestamp updates

alter table public.profiles
  add column if not exists last_avatar_update timestamptz;

create or replace function public.enforce_profile_avatar_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining interval;
  remaining_days integer;
begin
  if new.profile_image_url is distinct from old.profile_image_url then
    if old.last_avatar_update is not null and (now() - old.last_avatar_update) < interval '14 days' then
      remaining := interval '14 days' - (now() - old.last_avatar_update);
      remaining_days := greatest(1, ceil(extract(epoch from remaining) / 86400.0)::int);
      raise exception 'You can change your profile picture again in % days', remaining_days
        using errcode = 'P0001';
    end if;

    new.last_avatar_update := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_profile_avatar_cooldown on public.profiles;

create trigger trg_enforce_profile_avatar_cooldown
before update on public.profiles
for each row
execute function public.enforce_profile_avatar_cooldown();
