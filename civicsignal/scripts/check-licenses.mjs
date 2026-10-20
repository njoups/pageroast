#!/usr/bin/env node
// License review of production dependencies (API + web), from the installed node_modules tree.
//   node scripts/check-licenses.mjs [--json]   → exit 1 when a dependency's license is denied or unknown and not reviewed
// Policy (docs/SUPPLY_CHAIN.md): permissive licenses pass; strong copyleft (GPL/AGPL/SSPL) fails; weak copyleft
// (LGPL/MPL/EPL) and unknown licenses need a recorded review in scripts/license-reviews.json.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Python-2\.0|CC-BY-4\.0|MIT-0|Zlib|WTFPL|PSF-2\.0)$/i;
const DENY = /\b(A?GPL|SSPL|BUSL|Commons-Clause)\b/i;
const reviews = existsSync(join(root, 'scripts/license-reviews.json')) ? JSON.parse(readFileSync(join(root, 'scripts/license-reviews.json'), 'utf8')) : {};

const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '-w', 'apps/api', '-w', 'apps/web'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString());
const seen = new Map();
(function walk(deps) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    const key = `${name}@${d.version}`;
    if (name.startsWith('@civicsignal/')) { walk(d.dependencies); continue; }   // our own private workspaces
    if (d.version && !seen.has(key)) {
      const pj = [join(root, 'node_modules', name, 'package.json'), d.path && join(d.path, 'package.json')].find((p) => p && existsSync(p));
      let lic = 'UNKNOWN';
      if (pj) { const m = JSON.parse(readFileSync(pj, 'utf8')); lic = typeof m.license === 'string' ? m.license : m.license?.type ?? (Array.isArray(m.licenses) ? m.licenses.map((x) => x.type).join(' OR ') : 'UNKNOWN'); }
      seen.set(key, { name, version: d.version, license: lic });
    }
    walk(d.dependencies);
  }
})(tree.dependencies);

const verdict = (lic) => {
  const parts = lic.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i);
  if (/\sOR\s/i.test(lic) && parts.some((p) => ALLOW.test(p.trim()))) return 'ok';      // dual-licensed: we elect the permissive option
  if (parts.every((p) => ALLOW.test(p.trim()))) return 'ok';
  if (DENY.test(lic) && !/LGPL/i.test(lic)) return 'denied';
  return 'review';
};
const counts = {}; const problems = [];
for (const d of seen.values()) {
  counts[d.license] = (counts[d.license] ?? 0) + 1;
  const v = verdict(d.license);
  if (v === 'ok') continue;
  const r = reviews[d.name];
  if (v === 'review' && r && (r.license === d.license)) continue;
  problems.push({ ...d, verdict: v, review: r ?? null });
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ total: seen.size, counts, problems }, null, 2));
else {
  console.log(`license check: ${seen.size} production packages`);
  for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
  for (const p of problems) console.log(`${p.verdict.toUpperCase()} ${p.name}@${p.version} (${p.license})`);
}
process.exit(problems.length ? 1 : 0);
