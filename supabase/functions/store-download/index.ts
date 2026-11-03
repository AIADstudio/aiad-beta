import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "store-digital";

// GUEST DELIVERY: a guest order has no account behind it, so the checkout session id
// is the only thing its buyer can present. This runs with verify_jwt FALSE and
// authenticates both kinds of caller itself, so entitlement to a digital purchase is
// still decided in exactly one place rather than forked into a second function.
//
// store-digital is private and its only storage policy lets an artist read their own
// folder. A buyer — guest or signed in — can never read it directly; a service-role
// signed URL from here is the whole delivery path.
//
// Signed-in buyers keep the full hour. A guest link lives ten minutes, because a
// session id is a weaker credential than a session token (it travels in a URL, in
// history, in a referrer) and a guest clicks the button on the receipt in front of
// them. Long enough to start a slow download, short enough that a leaked id is not a
// standing key to the file.
const TTL_USER  = 3600;
const TTL_GUEST = 600;

const SESSION_RE = /^cs_[A-Za-z0-9_]{10,200}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  try {
    // The anon key is what an unauthenticated browser sends as its bearer, so it has
    // to be told apart from a real user token.
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let user_id: string | null = null;
    if (bearer && bearer !== ANON_KEY) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (user) user_id = user.id;
    }

    const body = await req.json().catch(() => ({}));
    const session_id = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    // Branch on what the caller actually presented, not on whether a token happened
    // to resolve — so a signed-in buyer whose token has expired still gets
    // "Not authenticated" rather than a confusing complaint about a session id.
    const ORDER_COLS = "id, product_id, artist_id, status, buyer_id";
    let ord: Record<string, unknown> | null = null;
    let ttl = TTL_USER;

    if (session_id) {
      if (!SESSION_RE.test(session_id)) throw new Error("Invalid session id");
      // `buyer_id is null` is the load-bearing clause. Without it, anyone holding a
      // SIGNED-IN buyer's session id could pull that buyer's file, straight past the
      // ownership check below. A session id may only ever open a guest's own order.
      //
      // A bag is several rows under one session id, so this is a list, not a row:
      // product_id picks the line. With a single-line bag it can be left out, which
      // keeps the one-item case a one-field request.
      const { data: rows } = await supa.from("orders").select(ORDER_COLS)
        .eq("stripe_session_id", session_id).eq("status", "paid").is("buyer_id", null);
      if (!rows || !rows.length) throw new Error("No paid guest order found for this download");
      const wanted = typeof body.product_id === "string" ? body.product_id.trim() : "";
      ord = wanted
        ? (rows.find((r) => String(r.product_id) === wanted) ?? null)
        : (rows.length === 1 ? rows[0] : null);
      if (!ord) throw new Error("Say which item in this order you want to download");
      ttl = TTL_GUEST;
    } else {
      if (!user_id) throw new Error("Not authenticated");
      const order_id = body.order_id;
      if (!order_id) throw new Error("order_id required");
      // The caller must own a PAID order for this product.
      const { data } = await supa.from("orders").select(ORDER_COLS)
        .eq("id", order_id).eq("buyer_id", user_id).eq("status", "paid")
        .maybeSingle();
      ord = data;
      if (!ord) throw new Error("No paid order found for this download");
    }

    const { data: prod } = await supa.from("products")
      .select("digital_file_url, product_kind").eq("id", ord.product_id).maybeSingle();
    if (!prod || prod.product_kind !== "digital" || !prod.digital_file_url) throw new Error("No digital file for this product");

    // digital_file_url stores the PATH within the private bucket ("<artist_id>/file.zip").
    // Signing is the one operation here that ignores RLS, so refuse a path that does
    // not sit under the seller's own folder: that first segment is exactly what the
    // storage policy keys on, and a wrongly written row should not be the thing that
    // decides which object gets handed out. Cannot be forged from outside today.
    const path = String(prod.digital_file_url);
    if (path.split("/")[0] !== String(ord.artist_id)) {
      console.error("[store-download] refused path outside seller folder, order", ord.id);
      throw new Error("No digital file for this product");
    }

    // Guests get Content-Disposition: attachment, so clicking saves the file and
    // leaves the receipt on screen. The signed-in client opens its link in a new tab
    // and has always rendered inline, so that branch is left exactly as it was.
    const { data: signed, error: sErr } = session_id
      ? await supa.storage.from(BUCKET).createSignedUrl(path, ttl, { download: true })
      : await supa.storage.from(BUCKET).createSignedUrl(path, ttl);
    if (sErr || !signed?.signedUrl) throw new Error("Could not create download link");

    return jsonResponse({ url: signed.signedUrl, expires_in: ttl });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 400);
  }
});
