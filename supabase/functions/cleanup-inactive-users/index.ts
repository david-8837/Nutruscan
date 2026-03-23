// Deploy: supabase functions deploy cleanup-inactive-users
// Required secrets:
// supabase secrets set CLEANUP_CRON_SECRET=your-long-random-secret
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided in Supabase Edge runtime)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const AVATAR_BUCKET = "profile-images";
const INACTIVITY_DAYS = 30;

type ProfileCandidate = {
  id: string;
  last_seen: string | null;
  profile_image_url: string | null;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function extractStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const raw = url.slice(idx + marker.length);
  const trimmed = raw.split("?")[0].trim();
  if (!trimmed) return null;
  return decodeURIComponent(trimmed);
}

function isObjectMissingError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "").toLowerCase();
  return msg.includes("not found") || msg.includes("does not exist") || msg.includes("no such object");
}

function isAuthUserMissingError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "").toLowerCase();
  return msg.includes("user not found") || msg.includes("not found") || msg.includes("does not exist");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const cronSecret = Deno.env.get("CLEANUP_CRON_SECRET") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const headerToken = req.headers.get("x-cron-secret") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!cronSecret || (headerToken !== cronSecret && bearerToken !== cronSecret)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!serviceRoleKey || !supabaseUrl) {
      return json({ error: "Missing Supabase runtime secrets" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const batchSizeRaw = Number((body as Record<string, unknown>).batch_size ?? 200);
    const batchSize = Number.isFinite(batchSizeRaw)
      ? Math.max(1, Math.min(1000, Math.floor(batchSizeRaw)))
      : 200;
    const dryRun = Boolean((body as Record<string, unknown>).dry_run ?? false);

    const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: candidates, error: candidatesError } = await admin
      .from("profiles")
      .select("id,last_seen,profile_image_url")
      .lt("last_seen", cutoff)
      .order("last_seen", { ascending: true })
      .limit(batchSize);

    if (candidatesError) {
      return json({ error: candidatesError.message }, 500);
    }

    const users: ProfileCandidate[] = (candidates ?? []) as ProfileCandidate[];

    if (dryRun) {
      return json({
        mode: "dry_run",
        inactivity_days: INACTIVITY_DAYS,
        cutoff,
        matched_users: users.length,
        users: users.map((u) => ({ id: u.id, last_seen: u.last_seen })),
      });
    }

    const results: Array<{ id: string; status: string; detail?: string }> = [];
    let authDeleted = 0;
    let profileDeleted = 0;
    let avatarDeleted = 0;

    for (const user of users) {
      const userId = String(user.id);

      try {
        const path = extractStoragePath(user.profile_image_url as string | null | undefined);
        if (path) {
          const { error: storageErr } = await admin.storage.from(AVATAR_BUCKET).remove([path]);
          if (storageErr && !isObjectMissingError(storageErr)) {
            throw new Error(`storage delete failed: ${storageErr.message}`);
          }
          if (!storageErr || !isObjectMissingError(storageErr)) {
            avatarDeleted += 1;
          }
        }

        const { error: authErr } = await admin.auth.admin.deleteUser(userId);
        if (authErr && !isAuthUserMissingError(authErr)) {
          throw new Error(`auth delete failed: ${authErr.message}`);
        }
        if (!authErr) {
          authDeleted += 1;
        }

        const { error: profileErr } = await admin
          .from("profiles")
          .delete()
          .eq("id", userId);
        if (profileErr) {
          throw new Error(`profile delete failed: ${profileErr.message}`);
        }
        profileDeleted += 1;

        results.push({ id: userId, status: "deleted" });
      } catch (error) {
        results.push({ id: userId, status: "failed", detail: String(error) });
      }
    }

    return json({
      mode: "delete",
      inactivity_days: INACTIVITY_DAYS,
      cutoff,
      scanned: users.length,
      auth_deleted: authDeleted,
      profiles_deleted: profileDeleted,
      avatars_deleted: avatarDeleted,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
