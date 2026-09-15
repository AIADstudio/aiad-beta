// Parses the nine `const SKILL_* = "..."` declarations out of the deployed
// stage-agent index.ts, decodes them with JS string-literal semantics (not JSON),
// and writes: skills/<slug>.txt (decoded bytes), skills/<slug>.sql (upsert with a
// dollar-quoted literal), and manifest.json (slug, name, bytes, sha256).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const [,, srcPath, outDir] = process.argv;
const src = readFileSync(srcPath, 'utf8');

// slug -> constant name, in the order STAGE_NAMES/SKILLS list them.
const MAP = {
  discover:         'SKILL_DISCOVER',
  develop:          'SKILL_DEVELOP',
  record_release:   'SKILL_RECORD_RELEASE',
  rights_royalties: 'SKILL_RIGHTS_ROYALTIES',
  touring_live:     'SKILL_TOURING_LIVE',
  brand_sync:       'SKILL_BRAND_SYNC',
  finances:         'SKILL_FINANCES',
  strategy_team:    'SKILL_STRATEGY_TEAM',
  contract_review:  'SKILL_CONTRACT_REVIEW',
};

// STAGE_NAMES from the source itself, so `name` is the deployed label, not a retype.
const namesBlock = src.match(/const STAGE_NAMES: Record<string, string> = \{([\s\S]*?)\n\};/);
if (!namesBlock) throw new Error('STAGE_NAMES not found');
const STAGE_NAMES = vm.runInNewContext('({' + namesBlock[1] + '})');

// Each constant is one line: const NAME = "<literal>";
function literalFor(constName) {
  const re = new RegExp('^const ' + constName + ' = ("(?:[^"\\\\]|\\\\.)*");\\s*$', 'm');
  const m = src.match(re);
  if (!m) throw new Error('constant not found: ' + constName);
  return m[1];
}

mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const [slug, constName] of Object.entries(MAP)) {
  const lit = literalFor(constName);
  const content = vm.runInNewContext(lit);           // JS string-literal decode
  if (typeof content !== 'string' || !content.length) throw new Error('bad decode: ' + slug);
  const buf = Buffer.from(content, 'utf8');
  const sha = createHash('sha256').update(buf).digest('hex');
  const name = STAGE_NAMES[slug];
  if (!name) throw new Error('no STAGE_NAMES entry for ' + slug);
  writeFileSync(`${outDir}/${slug}.txt`, buf);
  // Dollar-quote tag chosen so it cannot occur in the body.
  const tag = '$sk_' + slug + '$';
  if (content.includes(tag)) throw new Error('dollar tag collision: ' + slug);
  const sql = `insert into public.stage_skills (slug, name, content)\nvalues (${JSON.stringify(slug).replace(/"/g, "'")}, ${JSON.stringify(name).replace(/"/g, "'")}, ${tag}${content}${tag})\non conflict (slug) do update set name = excluded.name, content = excluded.content\nreturning slug, length(content) as chars, octet_length(content) as bytes, sha256, version;\n`;
  writeFileSync(`${outDir}/${slug}.sql`, sql);
  manifest.push({ slug, name, bytes: buf.length, chars: content.length, sha256: sha });
}
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
for (const m of manifest) console.log(m.slug.padEnd(17), String(m.bytes).padStart(6), m.sha256);
