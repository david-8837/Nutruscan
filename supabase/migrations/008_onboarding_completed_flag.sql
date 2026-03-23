-- Prevent OAuth users from skipping onboarding by tracking completion server-side

alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false;

-- Mark existing sufficiently-complete profiles as onboarded to avoid forcing setup for all existing users.
update public.profiles
set onboarding_completed = true
where coalesce(onboarding_completed, false) = false
  and age is not null
  and height is not null
  and weight is not null
  and nullif(trim(coalesce(gender, '')), '') is not null
  and nullif(trim(coalesce(activity, '')), '') is not null
  and nullif(trim(coalesce(goal, '')), '') is not null;
