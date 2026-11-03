import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// DIRECT CHARGES: the sale happens on the artist's connected account, so this
// arrives as a CONNECT event (event.account = the artist's account). We only
// record the order + deliver the goods. Money is in the artist's Stripe balance;
// there is NO internal wallet to credit.
//
// A bag is several orders rows sharing one stripe_session_id, so everything here
// works on the whole set rather than a single row. The `status = pending` filter on
// the flip is what keeps it exactly-once: a replayed event matches nothing and the
// rest of the handler is skipped.
const WEBHOOK_SECRET = Deno.env.get("STORE_WEBHOOK_SECRET")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const enc = new TextEncoder();
async function verifyStripeSig(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const ts = parts.t; const sig = parts.v1;
  if (!ts || !sig) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
  const hex = Array.from(new Uint8Array(macBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hex.length; i++) mismatch |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return mismatch === 0;
}

serve(async (req) => {
  const sigHeader = req.headers.get("stripe-signature") ?? "";
  const payload   = await req.text();
  if (!await verifyStripeSig(payload, sigHeader, WEBHOOK_SECRET)) {
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  const supa  = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      if (s.metadata?.kind !== "store_order") return new Response("ignored", { status: 200 });

      const shipping = s.shipping_details ?? s.customer_details ?? null;

      // Flip every claimable line of this bag to paid, exactly once.
      //
      // 'abandoned' counts as claimable. A session swept to abandoned stays open on
      // Stripe for 24 hours, and a payment is a fact where abandonment was only ever
      // an inference — on 2026-11-03 six live sessions were swept while still open.
      // Refusing to claim one would take the card and record nothing: no inventory
      // move, no seller notification, and a 200 back to Stripe. Still exactly-once,
      // because a row already 'paid' matches neither value.
      const { data: ords } = await supa.from("orders")
        .update({ status: "paid", stripe_payment_intent: s.payment_intent ?? null, shipping, updated_at: new Date().toISOString() })
        .eq("stripe_session_id", s.id).in("status", ["pending", "abandoned"])
        .select("id, buyer_id, product_id, quantity");

      const rows = ords ?? [];
      if (rows.length) {
        // A guest order has no account to read an email off, so the address Stripe
        // collected on its own page is the only way to reach the buyer about their
        // own purchase. One update covers every guest line of the bag. Written
        // separately from the status flip above, and swallowed on failure: if
        // guest_email isn't in the schema yet, the sale must still record as paid
        // rather than have Stripe retry the event forever.
        if (rows.some((r) => !r.buyer_id)) {
          const guestEmail = s.customer_details?.email ?? null;
          if (guestEmail) {
            const { error: gErr } = await supa.from("orders")
              .update({ guest_email: guestEmail })
              .eq("stripe_session_id", s.id).is("buyer_id", null);
            if (gErr) console.error("[store-webhook] guest_email not stored:", gErr.message);
          }
        }

        // Inventory comes off the TOTAL per product, not per row: the same product
        // can appear on two lines in two sizes, and decrementing row by row would
        // read a stale count in between.
        const qtyByProduct = new Map<string, number>();
        for (const r of rows) {
          const pid = String(r.product_id);
          qtyByProduct.set(pid, (qtyByProduct.get(pid) ?? 0) + Number(r.quantity || 1));
        }

        // Digital delivery marker + physical inventory. (No wallet credit — money is
        // in the artist's connected account; Stripe pays them out.)
        for (const [pid, qty] of qtyByProduct) {
          const { data: prod } = await supa.from("products")
            .select("product_kind, digital_file_url, inventory").eq("id", pid).maybeSingle();
          if (!prod) continue;
          if (prod.product_kind === "digital" && prod.digital_file_url) {
            const ids = rows.filter((r) => String(r.product_id) === pid).map((r) => r.id);
            await supa.from("orders").update({ digital_download_url: prod.digital_file_url }).in("id", ids);
          }
          if (prod.product_kind === "physical" && prod.inventory != null) {
            const newInv = Math.max(0, Number(prod.inventory) - qty);
            await supa.from("products").update({ inventory: newInv }).eq("id", pid);
          }
        }
      }
    }
  } catch (err) {
    console.error("[store-webhook]", event.type, err);
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
