# stage_skills seed (2026-09-15)

The nine skill bodies now live in `public.stage_skills` (service-role only; a
BEFORE INSERT/UPDATE trigger stamps `sha256` from `content`). They were seeded
byte-exact from the deployed stage-agent v28 source, which is byte-identical to
`git show 40e8bd5:supabase/functions/stage-agent/index.ts`.

`parse_skills.mjs <index.ts> <outdir>` parses the nine `const SKILL_* = "..."`
declarations, decodes them with JS string-literal semantics (not JSON), and
writes one `<slug>.txt` (decoded bytes), one `<slug>.sql` (upsert with a
dollar-quoted literal) and `manifest.json` (slug, name, bytes, sha256).

`manifest.json` here is the record of what was seeded. Verified after the
upserts: all nine `sha256` values stored by the trigger matched the hashes
computed locally off the parsed constants.
