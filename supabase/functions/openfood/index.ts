// Deploy: supabase functions deploy openfood
// Proxies Open Food Facts (required User-Agent). No extra secrets.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const UA =
  Deno.env.get("OPENFOOD_USER_AGENT") ||
  "NutriScan/1.0 (Supabase Edge; https://openfoodfacts.org)";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return json({ error: "Missing authorization" }, 401);
    }
    const jwt = auth.replace("Bearer ", "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return json({ error: "Invalid session" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const action = body.action;
    const headers = { "User-Agent": UA, Accept: "application/json" };

    if (action === "search") {
      const q = String(body.q ?? "").trim().slice(0, 200);
      if (!q) {
        return json({ products: [], count: 0 });
      }
      const url =
        `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${
          encodeURIComponent(q)
        }&search_simple=1&action=process&json=1&page_size=40&fields=product_name,brands,nutriments,serving_size,categories_tags,image_front_small_url,nutriscore_grade`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return json(data, r.ok ? 200 : 502);
    }

    if (action === "product") {
      const code = String(body.code ?? "").replace(/[^\dA-Za-z]/g, "").slice(
        0,
        32,
      );
      if (!code) {
        return json({ status: 0, status_verbose: "invalid code" });
      }
      const r = await fetch(
        `https://world.openfoodfacts.org/api/v0/product/${code}.json`,
        { headers },
      );
      const data = await r.json();
      return json(data, r.ok ? 200 : 502);
    }

    return json({ error: "Unknown action (use search | product)" }, 400);
  } catch (e) {
    return json({ error: String(e), products: [] }, 502);
  }
});
