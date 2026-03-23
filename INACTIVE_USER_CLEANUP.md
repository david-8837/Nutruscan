# Inactive User Cleanup (30 Days)

This setup deletes inactive users (no activity for 30+ days) across:
- `public.profiles`
- `auth.users`
- `storage.objects` in bucket `profile-images` (if avatar exists)

## 1) SQL: Find inactive users

Use this query to preview users before deletion:

```sql
select
  id,
  email,
  last_seen,
  profile_image_url
from public.profiles
where last_seen is not null
  and last_seen < now() - interval '30 days'
order by last_seen asc;
```

If `email` is not stored in `profiles`, use this instead:

```sql
select
  p.id,
  p.last_seen,
  p.profile_image_url,
  u.email
from public.profiles p
left join auth.users u on u.id = p.id
where p.last_seen is not null
  and p.last_seen < now() - interval '30 days'
order by p.last_seen asc;
```

## 2) Edge Function

Function file: `supabase/functions/cleanup-inactive-users/index.ts`

What it does:
1. Finds users where `last_seen < now() - 30 days`
2. Deletes avatar object from `profile-images` bucket (if path exists)
3. Deletes Supabase Auth user (`auth.admin.deleteUser`)
4. Deletes row from `public.profiles` (safe if no FK cascade)

Security:
- Requires `CLEANUP_CRON_SECRET` in `Authorization: Bearer <secret>` or `x-cron-secret`
- Uses `SUPABASE_SERVICE_ROLE_KEY` only inside Edge runtime

## 3) Deploy function and set secrets

```bash
supabase secrets set CLEANUP_CRON_SECRET="your-long-random-secret"
supabase functions deploy cleanup-inactive-users
```

## 4) Dry run first (recommended)

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/cleanup-inactive-users" \
  -H "Authorization: Bearer your-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true, "batch_size": 200}'
```

## 5) Schedule daily with pg_cron + pg_net

Run in SQL Editor (adjust project ref and secret):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'cleanup-inactive-users-daily',
  '15 2 * * *',
  $$
  select
    net.http_post(
      url := 'https://<project-ref>.functions.supabase.co/cleanup-inactive-users',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer your-long-random-secret'
      ),
      body := '{"batch_size":200}'::jsonb
    );
  $$
);
```

Check jobs:

```sql
select * from cron.job;
```

Unschedule if needed:

```sql
select cron.unschedule('cleanup-inactive-users-daily');
```

## 6) Safety best practices

1. **Always run dry-run first** and inspect IDs before enabling schedule.
2. **Use batch limits** (e.g., 100-500) to avoid deleting too many users in one run.
3. **Keep an audit trail**: log function response to external monitoring or a table.
4. **Protect secret**: never expose `CLEANUP_CRON_SECRET` in frontend code.
5. **Fail per-user, continue loop**: one bad user should not stop entire cleanup.
6. **Start with conservative cadence** (daily) and monitor for a week.
7. **Consider soft-delete period** (optional) if compliance/business requires recovery.

## 7) Optional: immediate one-time cleanup run

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/cleanup-inactive-users" \
  -H "Authorization: Bearer your-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 200}'
```
