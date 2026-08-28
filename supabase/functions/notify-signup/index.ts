// Emails the founder when a new user signs up. Triggered by a Supabase Database
// Webhook on INSERT into public.profiles.
//
// This was an open relay: no authentication of any kind, and it interpolated the
// posted record straight into an HTML email. Anyone could POST arbitrary content
// and have it arrive, rendered, in the founder's inbox — a ready-made phishing
// vector wearing our own From address.
//
// Two fixes: a shared secret the caller must present, and HTML-escaping of every
// interpolated field.
//
// Env: NOTIFY_SIGNUP_SECRET (required), RESEND_API_KEY (required),
//      RESEND_FROM (optional), NOTIFY_TO (optional, default founder@aiad.studio).
//
// The Database Webhook must send the secret as an `x-aiad-signature` header.
// If NOTIFY_SIGNUP_SECRET is unset this function fails CLOSED — it refuses every
// request rather than reverting to being an open relay.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("RESEND_FROM") ?? "AIAD <onboarding@resend.dev>";
const TO = Deno.env.get("NOTIFY_TO") ?? "founder@aiad.studio";
const SECRET = Deno.env.get("NOTIFY_SIGNUP_SECRET") ?? "";

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-aiad-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

// Compare SHA-256 digests rather than the raw strings: the digests are always the
// same length, so the comparison is constant-time regardless of how wrong the
// candidate is, and its length leaks nothing.
async function secretMatches(given: string): Promise<boolean> {
    if (!SECRET || !given) return false;
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", enc.encode(given)),
        crypto.subtle.digest("SHA-256", enc.encode(SECRET)),
    ]);
    const x = new Uint8Array(a), y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

// A newline in a subject line is header injection. Strip control characters and
// keep it short; this is the one field that does not go through esc().
function subjectSafe(v: unknown): string {
    return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

// Every value below comes from the posted row, so none of it may reach the email
// as markup.
function esc(v: unknown): string {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .slice(0, 300);
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
        if (!SECRET) {
            console.error("[notify-signup] NOTIFY_SIGNUP_SECRET not set — refusing all requests");
            return json({ error: "not configured" }, 503);
        }
        if (!(await secretMatches(req.headers.get("x-aiad-signature") ?? ""))) {
            return json({ error: "unauthorized" }, 401);
        }
        if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not set" }, 500);

        const body = await req.json().catch(() => ({}));
        const rec = body.record ?? body.new ?? body;      // DB webhook sends { record }
        if (!rec || (!rec.email && !rec.username && !rec.id)) {
            return json({ skipped: true });
        }

        const rawName = rec.full_name || rec.username || rec.email || "New user";
        const name = esc(rawName);
        const role = esc(rec.role || "user");
        const email = esc(rec.email ?? "—");
        const username = rec.username ? "@" + esc(rec.username) : "—";
        const industry = esc(rec.industry ?? "—");

        const html = `
      <div style="font-family:Inter,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 8px">🆕 New AIAD signup</h2>
        <p style="font-size:16px;margin:0 0 4px"><strong>${name}</strong> — ${role}</p>
        <table style="font-size:14px;color:#333;border-collapse:collapse">
          <tr><td style="padding:2px 10px 2px 0;color:#888">Email</td><td>${email}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:#888">Username</td><td>${username}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:#888">Industry</td><td>${industry}</td></tr>
        </table>
        <p style="margin-top:16px"><a href="https://aiad.studio/admin" style="background:#00B4D8;color:#001018;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open admin dashboard</a></p>
      </div>`;

        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: FROM, to: [TO], subject: `🆕 New AIAD signup: ${subjectSafe(rawName)}`, html }),
        });
        const out = await r.json().catch(() => ({}));
        return json({ ok: r.ok, resend: out }, r.ok ? 200 : 502);
    } catch (e) {
        return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
});
