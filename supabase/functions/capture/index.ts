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

  const { error } = await supabase.from("entries").insert({
    id,
    user_id: OWNER_USER_ID,
    created_at: new Date().toISOString(),
    type: "note",
    title: "",
    body: text,
    tags: ["shared"],
    due_at: null,
    done: false,
    done_at: null,
    pinned: false,
    source: "share-sheet",
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ ok: true, id }), { status: 200, headers: corsHeaders });
});
