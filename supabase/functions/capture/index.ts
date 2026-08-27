// Commonplace — share-sheet capture endpoint.
//
// Called by an iOS Shortcut (see CLAUDE.md for how it's wired up), not by the web app itself.
// Auth model: this is a single-user app, so instead of a full OAuth dance for a Shortcut, the
// Shortcut sends a long random secret (CAPTURE_SECRET) that only it and this function know.
// That secret is the only thing gating the insert — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are auto-injected by Supabase into every Edge Function, so they're never pasted in manually,
// and the service role key never leaves this server-side function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CAPTURE_SECRET = Deno.env.get("CAPTURE_SECRET")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

// Pulls every <meta property="..."/name="..." content="..."> tag into a lookup,
// regardless of attribute order — real-world pages write these inconsistently.
function extractMetaTags(html: string): Record<string, string> {
  const metas: Record<string, string> = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const propMatch = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (propMatch && contentMatch) {
      metas[propMatch[1].toLowerCase()] = contentMatch[1];
    }
  }
  return metas;
}

async function fetchPageMeta(url: string): Promise<{ title: string | null; imageUrl: string | null }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CommonplaceBot/1.0)" },
    });
    clearTimeout(timeout);
    if (!resp.ok) return { title: null, imageUrl: null };

    const html = await resp.text();
    const metas = extractMetaTags(html);
    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

    const rawTitle = metas["og:title"] || metas["twitter:title"] || (titleTagMatch ? titleTagMatch[1] : null);
    const title = rawTitle ? decodeEntities(rawTitle) : null;

    let imageUrl = metas["og:image"] || metas["og:image:url"] || metas["twitter:image"] || null;
    if (imageUrl) imageUrl = decodeEntities(imageUrl);
    if (imageUrl) {
      try {
        imageUrl = new URL(imageUrl, url).href; // resolve relative image paths against the page URL
      } catch {
        // leave as-is if it doesn't parse; the <img> will just fail to load
      }
    }

    return { title, imageUrl };
  } catch {
    return { title: null, imageUrl: null };
  }
}

function looksLikeUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: corsHeaders });
  }

  if (!CAPTURE_SECRET || body.secret !== CAPTURE_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
  }

  const text = String(body.text || "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "no text" }), { status: 400, headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const id = "e" + Date.now() + Math.floor(Math.random() * 1000);

  const isUrl = looksLikeUrl(text);
  let title = "";
  let imageUrl: string | null = null;
  if (isUrl) {
    const meta = await fetchPageMeta(text);
    title = meta.title || "";
    imageUrl = meta.imageUrl;
  }
  const tags = isUrl ? ["shared", "link"] : ["shared"];

  const { error } = await supabase.from("entries").insert({
    id,
    user_id: OWNER_USER_ID,
    created_at: new Date().toISOString(),
    type: "note",
    title,
    body: text,
    tags,
    image_url: imageUrl,
    due_at: null,
    done: false,
    done_at: null,
    pinned: false,
    source: "share-sheet",
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ ok: true, id, title, imageUrl, isUrl }), { status: 200, headers: corsHeaders });
});
