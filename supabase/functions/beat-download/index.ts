// beat-download — the only way a beat buyer reaches a purchased deliverable.
//
//   POST /beat-download { beat_id, kind }   kind: mp3_untagged | wav | stems_zip | midi | project_file
//
// Why this function has to exist: the beat-files bucket is private and its storage
// policy grants SELECT only where the first folder is auth.uid() — the PRODUCER.
// A buyer can read the beat_files ROW (the table's policy is has_beat_file_access)
// but cannot sign the object behind it, so the browser can only mint a URL for a
// producer's own files. The service role closes that gap here.
//
// Entitlement is NOT re-implemented in TypeScript. has_beat_file_access(beat, kind)
// is the very function the beat_files SELECT policy uses, and it is called through
// the CALLER's client so auth.uid() is them. If the rule changes in the database,
// this function follows it rather than drifting from it. The service role is used
// only after that check passes, and only to read the path and sign it.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const BUCKET = "beat-files";
const TTL_SECONDS = 120;

// The kinds beat_files is allowed to hold, and the extension each falls back to.
const KINDS: Record<string, string> = {
  mp3_untagged: "mp3",
  wav: "wav",
  stems_zip: "zip",
  midi: "mid",
  project_file: "zip",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json({ error: "Not authenticated", reason: "no_session" }, 401);

    const { beat_id, kind } = await req.json().catch(() => ({} as any));
    if (!beat_id || !kind) return json({ error: "beat_id and kind are required", reason: "bad_request" }, 400);
    if (!Object.prototype.hasOwnProperty.call(KINDS, String(kind))) {
      return json({ error: `kind must be one of ${Object.keys(KINDS).join(", ")}`, reason: "bad_kind" }, 400);
    }
    const kindKey = String(kind);

    // 1. Entitlement, as the database defines it. Producer of the beat, or a buyer
    //    whose PAID tier lists this kind among its deliverables.
    const { data: allowed, error: aErr } = await userClient
      .rpc("has_beat_file_access", { p_beat: beat_id, p_kind: kindKey });
    if (aErr) {
      console.error("[beat-download] access check failed", aErr.message, aErr.code);
      return json({ error: aErr.message, reason: "access_check_failed" }, 400);
    }
    if (allowed !== true) {
      return json({
        error: "That file is not part of a licence on this account",
        reason: "not_entitled",
      }, 403);
    }

    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    // 2. Resolve the file. Read with the service role because the caller may be a
    //    buyer, whose own read of this row is fine but whose storage SELECT is not.
    const { data: file, error: fErr } = await supa.from("beat_files")
      .select("path, bytes, kind")
      .eq("beat_id", beat_id).eq("kind", kindKey).maybeSingle();
    if (fErr) {
      console.error("[beat-download] file read failed", fErr.message, fErr.code);
      return json({ error: fErr.message, reason: "lookup_failed" }, 400);
    }
    if (!file?.path) {
      return json({
        error: "The producer has not uploaded that file yet",
        reason: "not_uploaded",
      }, 404);
    }

    const { data: beat, error: bErr } = await supa.from("beats")
      .select("id, title, producer_id")
      .eq("id", beat_id).maybeSingle();
    if (bErr || !beat) {
      console.error("[beat-download] beat read failed", bErr?.message);
      return json({ error: "Beat not found", reason: "beat_not_found" }, 404);
    }

    // 3. The path must sit under its own producer's folder. The row came from the
    //    database rather than the caller, so this cannot be forged from outside —
    //    but a row written wrongly by any future code path would otherwise let the
    //    service role sign an object belonging to someone else, and signing is the
    //    one thing here that ignores RLS. Cheap check, no way back once it is wrong.
    if (String(file.path).split("/")[0] !== String(beat.producer_id)) {
      console.error("[beat-download] path/producer mismatch", file.path, beat.producer_id);
      return json({ error: "Could not create a download link", reason: "path_mismatch" }, 400);
    }

    const ext = String(file.path).match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? KINDS[kindKey];
    const safeTitle = String(beat.title || "beat").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "beat";
    const filename = `${safeTitle} - ${kindKey}.${ext}`;

    const { data: signed, error: sErr } = await supa.storage.from(BUCKET)
      .createSignedUrl(file.path, TTL_SECONDS, { download: filename });
    if (sErr || !signed?.signedUrl) {
      console.error("[beat-download] sign failed", file.path, sErr?.message);
      return json({ error: "Could not create a download link", reason: "sign_failed" }, 400);
    }

    return json({
      url: signed.signedUrl,
      expires_in: TTL_SECONDS,
      kind: kindKey,
      filename,
      bytes: file.bytes ?? null,
    });
  } catch (err) {
    console.error("[beat-download] unhandled", err);
    return json({ error: String((err as Error).message ?? err) }, 400);
  }
});
