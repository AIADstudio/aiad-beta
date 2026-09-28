import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// DIRECT CHARGES: the sale happens on the artist's connected account, so this
// arrives as a CONNECT event (event.account = the artist's account). We only
// record the order + deliver the goods. Money is in the artist's Stripe balance;
// there is NO internal wallet to credit.
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

      // Flip pending -> paid exactly once.
      const { data: ord } = await supa.from("orders")
        .update({ status: "paid", stripe_payment_intent: s.payment_intent ?? null, shipping, updated_at: new Date().toISOString() })
        .eq("stripe_session_id", s.id).eq("status", "pending")
        .select("id, product_id, quantity").maybeSingle();

      if (ord) {
        // Digital delivery marker + physical inventory. (No wallet credit — money is
        // in the artist's connected account; Stripe pays them out.)
        const { data: prod } = await supa.from("products")
          .select("product_kind, digital_file_url, inventory").eq("id", ord.product_id).maybeSingle();
        if (prod) {
          if (prod.product_kind === "digital" && prod.digital_file_url) {
            await supa.from("orders").update({ digital_download_url: prod.digital_file_url }).eq("id", ord.id);
          }
          if (prod.product_kind === "physical" && prod.inventory != null) {
            const newInv = Math.max(0, Number(prod.inventory) - Number(ord.quantity || 1));
            await supa.from("products").update({ inventory: newInv }).eq("id", ord.product_id);
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
