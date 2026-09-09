// distributor-pack — builds the ready-to-upload package an artist takes to their
// own distributor.
//
// AIAD does not deliver to DSPs. This function collects everything the artist has
// already given us — masters, artwork, metadata, credits — and hands it back as one
// zip in the field order their distributor's form asks for. The upload is theirs.
//
// verify_jwt is on at the platform level, but that alone proves nothing: the anon
// key is itself a valid JWT and satisfies it. getUser() is what distinguishes a
// signed-in artist from anyone holding the public key, and the release must be
// theirs — a pack contains private masters.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { strToU8, zipSync } from "https://esm.sh/fflate@0.8.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DELIVERY_BUCKET = "release-deliveries";
const ART_MIN_PX = 3000;

/* Edge memory is finite and a WAV album is not. Past this the remaining masters are
   left out and named in warnings, which is a pack the artist can still use minus the
   tracks they now know to add by hand — better than a function that dies at 100%. */
const MAX_AUDIO_BYTES = 220 * 1024 * 1024;

const SONGWRITER_ROLES = new Set(["songwriter", "writer", "composer", "lyricist"]);

const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── small helpers ───────────────────────────────────────────────────────────
const yn = (v: unknown) => (v ? "Yes" : "No");

function slug(s: string): string {
    return (s || "untitled").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

function pad2(n: number): string { return n < 10 ? "0" + n : String(n); }

/* YYYY-MM-DD. A date column arrives as "2026-04-01" already; a timestamptz needs
   the UTC calendar date, not the edge runtime's idea of local midnight. */
function ymd(v: unknown): string {
    if (!v) return "";
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function extOf(path: string): string {
    const m = /\.([A-Za-z0-9]+)$/.exec(path || "");
    const e = m ? m[1].toLowerCase() : "";
    return e === "flac" ? "flac" : "wav";
}

// RFC4180: quote everything that could carry a delimiter, and double inner quotes.
function csvCell(v: unknown): string {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

/* Dimensions straight from the file header — there is no image library here and we
   only need width and height. Returns null for anything that is not a PNG or JPEG,
   which is not an error: artwork upload already restricts to those two. */
function imageSize(b: Uint8Array): { w: number; h: number } | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let p = 2;
        while (p + 9 < b.length) {
            if (b[p] !== 0xff) { p++; continue; }
            const marker = b[p + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
            const len = dv.getUint16(p + 2);
            // SOF0–SOF15 carry the frame header; DHT/DAC/SOS in that range do not.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { h: dv.getUint16(p + 5), w: dv.getUint16(p + 7) };
            }
            if (len < 2) break;
            p += 2 + len;
        }
    }
    return null;
}

// ── the artist's own upload order ───────────────────────────────────────────
const DISTROKID_ORDER = [
    "Number of songs",
    "Artist name",
    "Release title",
    "Record label",
    "Release date",
    "Genres",
    "Language",
    "Explicit",
    "Per-track: title, ISRC (or let DistroKid assign), songwriters' full legal names, "
        + "featured artists, producer, explicit, preview clip start",
    "Cover art — the file in artwork/ in this pack",
    "Audio — the files in audio/ in this pack",
    "Previously released? → enter the Original Release Date and the UPC/ISRC from this sheet",
];

const GENERIC_ORDER = [
    "Release type and number of tracks",
    "Artist name",
    "Release title (and version, if any)",
    "Record label",
    "Release date",
    "Genres",
    "Language",
    "Explicit / parental advisory",
    "Per-track: title, ISRC (or let the distributor assign), songwriters' full legal names, "
        + "featured artists, producer, explicit, preview clip start",
    "Cover art — the file in artwork/ in this pack",
    "Audio — the files in audio/ in this pack",
    "Previously released? → enter the Original Release Date and the UPC/ISRC from this sheet",
];

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    try {
        if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "server misconfigured" }, 500);
        const supa = createClient(SUPABASE_URL, SERVICE_KEY);

        const auth = req.headers.get("Authorization") ?? "";
        if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
        const { data: ud, error: ue } = await supa.auth.getUser(auth.slice(7));
        if (ue || !ud?.user) return json({ error: "unauthorized" }, 401);
        const userId = ud.user.id;

        let body: any;
        try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
        const releaseId = String(body?.release_id ?? "");
        if (!releaseId) return json({ error: "release_id required" }, 400);

        // ── the release, and only if it is theirs ───────────────────────────
        const { data: rel, error: relErr } = await supa.from("releases")
            .select("*").eq("id", releaseId).maybeSingle();
        if (relErr) return json({ error: `release read: ${relErr.message}` }, 500);
        if (!rel) return json({ error: "not found" }, 404);
        if (rel.user_id !== userId) return json({ error: "forbidden" }, 403);

        const { data: trackRows, error: trErr } = await supa.from("tracks")
            .select("*").eq("release_id", releaseId).order("track_number", { ascending: true });
        if (trErr) return json({ error: `tracks read: ${trErr.message}` }, 500);
        const tracks = trackRows ?? [];
        if (!tracks.length) return json({ error: "This release has no tracks yet." }, 400);

        const { data: contribRows, error: cErr } = await supa.from("track_contributors")
            .select("track_id, role, legal_name, stage_name, share_percent, publisher_name, pro, ipi_cae, instrument")
            .in("track_id", tracks.map((t: any) => t.id));
        if (cErr) return json({ error: `contributors read: ${cErr.message}` }, 500);
        const byTrack = new Map<string, any[]>();
        for (const c of contribRows ?? []) {
            const list = byTrack.get(c.track_id) ?? [];
            list.push(c);
            byTrack.set(c.track_id, list);
        }

        const { data: rights } = await supa.from("release_rights_declarations")
            .select("owns_master, split_sheet_url, signed_legal_name").eq("release_id", releaseId).maybeSingle();

        // ── whose form are we writing for ───────────────────────────────────
        const { data: prof } = await supa.from("profiles")
            .select("distributor_slug, distributor_other_name").eq("id", userId).maybeSingle();
        const distSlug = prof?.distributor_slug ?? "";
        let distName = "";
        let uploadUrl = "";
        if (distSlug && distSlug !== "other") {
            const { data: d } = await supa.from("distributors")
                .select("slug, name, upload_url").eq("slug", distSlug).maybeSingle();
            distName = d?.name ?? distSlug;
            uploadUrl = d?.upload_url ?? "";
        } else if (distSlug === "other") {
            distName = prof?.distributor_other_name ?? "";
        }
        // Warnings name the artist's own distributor rather than asserting DistroKid's
        // rules at someone on TuneCore. The 3000×3000 floor is universal either way.
        const distLabel = distName || "Your distributor";

        const warnings: string[] = [];
        const files: Record<string, [Uint8Array, Record<string, unknown>]> = {};

        /* QC failures do not block the pack — the artist may have a reason to ship the
           file anyway — but they lead the warnings, because they are the one thing here
           that gets a release bounced back at the far end. */
        for (const t of tracks) {
            if (t.derivatives_status === "qc_failed") {
                warnings.push(`Track “${t.title || "Untitled"}” failed AIAD QC (loudness/true-peak); ${distLabel} may reject it.`);
            }
        }

        // ── (a) masters ─────────────────────────────────────────────────────
        // Already-compressed audio gains nothing from deflate and costs a lot of CPU,
        // so it is stored, not compressed. The text entries still are.
        const audioNameFor = new Map<string, string>();
        let audioBytes = 0;
        for (const t of tracks) {
            const n = Number(t.track_number) || (tracks.indexOf(t) + 1);
            if (!t.storage_path) {
                warnings.push(`“${t.title || "Untitled"}” has no master uploaded — it is not in this pack.`);
                continue;
            }
            let name = `audio/${pad2(n)}-${slug(t.title)}.${extOf(t.storage_path)}`;
            for (let dup = 2; files[name]; dup++) {
                name = `audio/${pad2(n)}-${slug(t.title)}-${dup}.${extOf(t.storage_path)}`;
            }
            const { data: blob, error: dlErr } = await supa.storage
                .from(t.bucket || DELIVERY_BUCKET).download(t.storage_path);
            if (dlErr || !blob) {
                warnings.push(`Could not read the master for “${t.title || "Untitled"}” (${dlErr?.message ?? "no file"}) — it is not in this pack.`);
                continue;
            }
            const buf = new Uint8Array(await blob.arrayBuffer());
            if (audioBytes + buf.length > MAX_AUDIO_BYTES) {
                warnings.push(`“${t.title || "Untitled"}” was left out — the pack hit its ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB audio limit. Upload that master to ${distLabel} by hand.`);
                continue;
            }
            audioBytes += buf.length;
            files[name] = [buf, { level: 0 }];
            audioNameFor.set(t.id, name);
        }

        // ── (b) artwork ─────────────────────────────────────────────────────
        let artworkName = "";
        if (rel.artwork_url) {
            try {
                const res = await fetch(rel.artwork_url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const art = new Uint8Array(await res.arrayBuffer());
                const isPng = art.length > 8 && art[0] === 0x89 && art[1] === 0x50;
                artworkName = isPng ? "artwork/cover.png" : "artwork/cover.jpg";
                files[artworkName] = [art, { level: 0 }];
                const size = imageSize(art);
                if (size && (size.w < ART_MIN_PX || size.h < ART_MIN_PX)) {
                    warnings.push(`Artwork is ${size.w}×${size.h}; ${distLabel} requires ${ART_MIN_PX}×${ART_MIN_PX} minimum.`);
                }
            } catch (e) {
                warnings.push(`Could not fetch the artwork (${(e as Error).message}) — add it by hand at ${distLabel}.`);
            }
        } else {
            warnings.push("This release has no artwork — you will need to upload cover art yourself.");
        }

        // ── shared per-track derivation, used by both the CSV and the JSON ──
        const territories = rel.territory_mode === "excluded"
            ? "Worldwide except " + (rel.excluded_territories ?? []).join(", ")
            : "Worldwide";
        const featured = (rel.featured_artists ?? []).join(", ");
        const releaseExplicit = yn(rel.parental_advisory === "explicit");

        const shaped = tracks.map((t: any) => {
            const cs = byTrack.get(t.id) ?? [];
            const writers = cs.filter((c) => SONGWRITER_ROLES.has(String(c.role || "").toLowerCase()));
            const producers = cs.filter((c) => String(c.role || "").toLowerCase() === "producer");
            const feats = cs.filter((c) => String(c.role || "").toLowerCase() === "featured");
            const named = (c: any) => c.stage_name || c.legal_name || "";
            const hasLyricist = cs.some((c) => String(c.role || "").toLowerCase() === "lyricist");
            return {
                t,
                cs,
                songwriters: writers.map((c) => `${c.legal_name || ""} (${c.share_percent ?? 0}%)`).join("; "),
                splits: writers.map((c) => `${c.share_percent ?? 0}%`).join("; "),
                producers: producers.map(named).filter(Boolean).join("; "),
                featuredOnTrack: feats.map(named).filter(Boolean).join("; "),
                instrumental: yn(!String(t.lyrics ?? "").trim() && !hasLyricist),
                audioFile: audioNameFor.get(t.id) ?? "",
            };
        });

        // ── (c) metadata.csv, in the distributor's field order ──────────────
        const HEADER = [
            "Release Title", "Version", "Release Type", "Primary Artist", "Featured Artists", "Label",
            "UPC", "Release Date", "Original Release Date", "Primary Genre", "Secondary Genre", "Language",
            "Explicit (release)", "Territories", "© Line", "℗ Line",
            "Track #", "Track Title", "Track Version", "ISRC", "Track Explicit", "Lyrics Language",
            "Songwriters (legal names)", "Songwriter Splits", "Producers", "Featured on Track",
            "Instrumental", "Is Cover", "Original Writers (if cover)", "Contains Sample",
            "Preview Start (sec)", "Duration (sec)", "Audio File",
        ];
        const lines = [csvRow(HEADER)];
        for (const s of shaped) {
            const t = s.t;
            lines.push(csvRow([
                rel.title, rel.version_subtitle, rel.release_type, rel.primary_artist_name, featured, rel.label_name,
                rel.upc, ymd(rel.go_live_at), ymd(rel.original_release_date),
                rel.primary_genre, rel.secondary_genre, rel.language,
                releaseExplicit, territories, rel.c_line, rel.p_line,
                t.track_number, t.title, t.version_subtitle, t.isrc, yn(t.explicit), t.lyrics_language,
                s.songwriters, s.splits, s.producers, s.featuredOnTrack,
                s.instrumental, yn(t.is_cover), t.is_cover ? (t.cover_original_writers ?? "") : "",
                yn(t.contains_sample),
                t.preview_start_seconds == null ? 30 : t.preview_start_seconds,
                t.duration_seconds ?? "",
                s.audioFile,
            ]));
        }
        // A BOM so Excel opens © and ℗ as themselves rather than mojibake.
        files["metadata.csv"] = [strToU8("﻿" + lines.join("\r\n") + "\r\n"), { level: 6 }];

        // ── (d) metadata.json, for distributors that take a bulk import ─────
        const jsonPack = {
            release: {
                title: rel.title, version: rel.version_subtitle, release_type: rel.release_type,
                primary_artist: rel.primary_artist_name, featured_artists: rel.featured_artists ?? [],
                label: rel.label_name, upc: rel.upc,
                release_date: ymd(rel.go_live_at), original_release_date: ymd(rel.original_release_date),
                primary_genre: rel.primary_genre, secondary_genre: rel.secondary_genre,
                language: rel.language, parental_advisory: rel.parental_advisory,
                explicit: rel.parental_advisory === "explicit",
                territories, territory_mode: rel.territory_mode,
                excluded_territories: rel.excluded_territories ?? [],
                c_line: rel.c_line, p_line: rel.p_line,
                artwork_file: artworkName || null,
                owns_master: rights?.owns_master ?? null,
                split_sheet_url: rights?.split_sheet_url ?? null,
                signed_legal_name: rights?.signed_legal_name ?? null,
                tracks: shaped.map((s) => ({
                    track_number: s.t.track_number, title: s.t.title, version: s.t.version_subtitle,
                    isrc: s.t.isrc, explicit: !!s.t.explicit, lyrics_language: s.t.lyrics_language,
                    instrumental: s.instrumental === "Yes",
                    is_cover: !!s.t.is_cover, cover_original_writers: s.t.cover_original_writers ?? null,
                    contains_sample: !!s.t.contains_sample,
                    preview_start_seconds: s.t.preview_start_seconds == null ? 30 : s.t.preview_start_seconds,
                    duration_seconds: s.t.duration_seconds ?? null,
                    audio_file: s.audioFile || null,
                    contributors: s.cs.map((c: any) => ({
                        role: c.role, legal_name: c.legal_name, stage_name: c.stage_name,
                        share_percent: c.share_percent, publisher_name: c.publisher_name,
                        pro: c.pro, ipi_cae: c.ipi_cae, instrument: c.instrument,
                    })),
                })),
            },
            generated_at: new Date().toISOString(),
            generated_by: "AIAD — prepared for upload, not delivered by AIAD",
            distributor: distName || null,
            warnings,
        };
        files["metadata.json"] = [strToU8(JSON.stringify(jsonPack, null, 2)), { level: 6 }];

        // ── (e) README.txt ──────────────────────────────────────────────────
        const order = distSlug === "distrokid" ? DISTROKID_ORDER : GENERIC_ORDER;
        const readme: string[] = [];
        readme.push(`Upload order for ${distName || "your distributor"}:`);
        readme.push("");
        order.forEach((step, i) => readme.push(`${String(i + 1).padStart(2, " ")}. ${step}`));
        readme.push("");
        readme.push("What is in this pack");
        readme.push(`  audio/          ${audioNameFor.size} master${audioNameFor.size === 1 ? "" : "s"}, exactly as you uploaded them`);
        readme.push(`  artwork/        ${artworkName ? artworkName.slice(8) : "(none — add your cover art yourself)"}`);
        readme.push("  metadata.csv    one row per track, in the field order above");
        readme.push("  metadata.json   the same data, for bulk import");
        if (warnings.length) {
            readme.push("");
            readme.push("Before you upload");
            warnings.forEach((w) => readme.push(`  - ${w}`));
        }
        readme.push("");
        readme.push("AIAD does not deliver to DSPs on your behalf. This pack is yours to upload.");
        if (uploadUrl) {
            readme.push("");
            readme.push(`Upload it here: ${uploadUrl}`);
        } else if (distName) {
            readme.push("");
            readme.push(`We do not have a release link for ${distName} — open it yourself and upload there.`);
        } else {
            readme.push("");
            readme.push("Set your distributor in AIAD settings and we will link you straight to its upload page.");
        }
        files["README.txt"] = [strToU8(readme.join("\n") + "\n"), { level: 6 }];

        // ── zip, store, sign ────────────────────────────────────────────────
        const zipped = zipSync(files as any, { level: 6 });
        const now = new Date();
        const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
            + `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
        const filename = `distributor-pack-${stamp}.zip`;
        const path = `${userId}/releases/${releaseId}/packs/${filename}`;

        const { error: upErr } = await supa.storage.from(DELIVERY_BUCKET)
            .upload(path, zipped, { contentType: "application/zip", upsert: true });
        if (upErr) return json({ error: `pack upload: ${upErr.message}` }, 500);

        const { data: signed, error: signErr } = await supa.storage.from(DELIVERY_BUCKET)
            .createSignedUrl(path, 3600);
        if (signErr || !signed?.signedUrl) return json({ error: `signing: ${signErr?.message ?? "no url"}` }, 500);

        /* The aiad_distribution row records that a pack was built, and nothing more —
           it is not a delivery receipt. It is only updated, never created: a release
           with no such row simply never asked for a pack destination. */
        await supa.from("release_destinations").update({
            provider_ref: path,
            delivered_at: new Date().toISOString(),
            notes: warnings.join(" | ") || null,
            updated_at: new Date().toISOString(),
        }).eq("release_id", releaseId).eq("destination", "aiad_distribution");

        return json({
            url: signed.signedUrl,
            filename,
            warnings,
            track_count: audioNameFor.size,
            bytes: zipped.length,
        });
    } catch (e) {
        console.error("[distributor-pack]", e);
        return json({ error: (e as Error).message ?? "unexpected error" }, 500);
    }
});
