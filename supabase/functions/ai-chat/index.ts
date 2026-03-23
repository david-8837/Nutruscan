// Deploy: supabase functions deploy ai-chat
// Secrets: supabase secrets set OPENROUTER_API_KEY=sk-or-...
// Optional: OPENROUTER_MODEL (default below)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TEXT_MODEL =
  Deno.env.get("OPENROUTER_MODEL") ||
  "arcee-ai/trinity-large-preview:free";
const TEXT_FALLBACK_MODEL =
  Deno.env.get("OPENROUTER_FALLBACK_MODEL") ||
  "google/gemini-2.0-flash-001";
/** Used when the request includes images (AI camera scan). Must be a vision-capable OpenRouter model. */
const VISION_MODEL =
  Deno.env.get("OPENROUTER_VISION_MODEL") ||
  Deno.env.get("OPENROUTER_MODEL") ||
  "google/gemini-2.0-flash-001";

/** NutriScan sends Anthropic-style vision parts; OpenRouter expects OpenAI-style content. */
function normalizeMessageContent(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
      const u = (p.image_url as { url?: string }).url;
      if (typeof u === "string") out.push({ type: "image_url", image_url: { url: u } });
      continue;
    }
    if (p.type === "image" && p.source && typeof p.source === "object") {
      const s = p.source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        const mt = typeof s.media_type === "string" ? s.media_type : "image/jpeg";
        const url = `data:${mt};base64,${s.data}`;
        out.push({ type: "image_url", image_url: { url } });
      }
    }
  }
  return out.length ? out : String(content);
}

function normalizeMessages(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as Record<string, unknown>;
    const role = msg.role;
    const content = normalizeMessageContent(msg.content);
    return { role, content };
  });
}

function messageUsesVision(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const c = (msg as Record<string, unknown>).content;
  if (!Array.isArray(c)) return false;
  return c.some((p) => {
    if (!p || typeof p !== "object") return false;
    const o = p as Record<string, unknown>;
    if (o.type === "image_url") return true;
    if (o.type === "image") return true;
    return false;
  });
}

function pickModel(messages: unknown[]): string {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(messageUsesVision) ? VISION_MODEL : TEXT_MODEL;
}

async function openRouterComplete(
  key: string,
  model: string,
  messages: unknown[],
) {
  const or = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": Deno.env.get("PUBLIC_APP_URL") || "https://nutriscan.app",
      "X-Title": "NutriScan",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
    }),
  });
  const j = await or.json().catch(() => ({}));
  if (!or.ok) {
    throw new Error((j as any)?.error?.message || (j as any)?.message || `OpenRouter ${or.status}`);
  }
  return j as any;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const jwt = auth.replace("Bearer ", "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const key = Deno.env.get("OPENROUTER_API_KEY");
    if (!key) {
      return new Response(
        JSON.stringify({
          error: "Server misconfigured: OPENROUTER_API_KEY not set",
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const { messages, system } = body as {
      messages: unknown[];
      system?: string;
    };

    const raw = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...(Array.isArray(messages) ? messages : []),
    ];
    const openrouterMessages = normalizeMessages(raw);
    const model = pickModel(openrouterMessages);

    let j: any;
    try {
      j = await openRouterComplete(key, model, openrouterMessages);
    } catch (e) {
      const canFallback = model === TEXT_MODEL && TEXT_FALLBACK_MODEL && TEXT_FALLBACK_MODEL !== TEXT_MODEL;
      if (!canFallback) {
        return new Response(
          JSON.stringify({
            error: String(e),
            content: [
              {
                text: "Sorry, the AI service is unavailable right now. Try again later.",
              },
            ],
          }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
      try {
        j = await openRouterComplete(key, TEXT_FALLBACK_MODEL, openrouterMessages);
      } catch (e2) {
        return new Response(
          JSON.stringify({
            error: String(e2),
            content: [
              {
                text: "Sorry, the AI service is unavailable right now. Try again later.",
              },
            ],
          }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
    }

    const text = j.choices?.[0]?.message?.content ?? "";
    return new Response(JSON.stringify({ content: [{ text }] }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: String(e),
        content: [{ text: "Something went wrong. Please try again." }],
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
