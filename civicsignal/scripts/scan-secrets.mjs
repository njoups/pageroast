#!/usr/bin/env node
// Secret scan over git-tracked files (no dependencies; runs in CI and locally).
//   node scripts/scan-secrets.mjs            → exit 1 when a finding is not allow-listed
// Findings print rule, file and line only: the matched value is never printed.
// Allow-list: scripts/secret-scan-allowlist.txt, one "path-regex<TAB>rule" per line (test fixtures, documented placeholders).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-key', /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // Placeholders such as <pw> or ${VAR} are not secrets.
  ['url-with-password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`$<]+:(?!\$\{|\/\/|<)[^\s@'"`$<]{3,}@[^\s'"`]+/i],
  ['assigned-secret', /\b(?:password|passwd|secret|api_?key|access_?token|auth_?token|credentials_key)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  ['env-secret-value', /^(?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|CREDENTIALS_KEY))=(?!\s*$|<)[^\s#]{8,}/m],
];
const allow = (() => {
  try {
    return readFileSync(join(root, 'scripts/secret-scan-allowlist.txt'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const [p, r] = l.split('\t'); return { path: new RegExp(p), rule: r?.trim() || '*' }; });
  } catch { return []; }
})();

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|ico|pdf|ttf|otf|woff2?|dump|zip|gz)$/i;
let findings = 0; let allowed = 0; let scanned = 0;
for (const f of files) {
  if (BINARY.test(f) || f.endsWith('package-lock.json')) continue;
  const p = join(root, f);
  let st; try { st = statSync(p); } catch { continue; }
  if (st.size > 2_000_000) continue;
  const lines = readFileSync(p, 'utf8').split('\n');
  scanned++;
  lines.forEach((line, i) => {
    for (const [rule, re] of RULES) {
      if (!re.test(line)) continue;
      if (allow.some((a) => a.path.test(f) && (a.rule === '*' || a.rule === rule))) { allowed++; continue; }
      findings++;
      console.log(`FINDING ${rule} ${f}:${i + 1}`);
    }
  });
}
// --history: also scan every added line in the repository history (secrets removed later still need rotation).
if (process.argv.includes('--history')) {
  const log = execFileSync('git', ['log', '-p', '--all', '--no-color', '--format=commit %H', '--', '.'], { cwd: root, maxBuffer: 512 * 1024 * 1024 }).toString().split('\n');
  let commit = ''; let file = '';
  for (const line of log) {
    if (line.startsWith('commit ')) { commit = line.slice(7, 19); continue; }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const rel = file.replace(/^civicsignal\//, '');
    if (BINARY.test(rel) || rel.endsWith('package-lock.json')) continue;
    for (const [rule, re] of RULES) {
      if (!re.test(line.slice(1))) continue;
      if (allow.some((a) => a.path.test(rel) && (a.rule === '*' || a.rule === rule))) { allowed++; continue; }
      findings++; console.log(`FINDING(history) ${rule} ${rel} @${commit}`);
    }
  }
}
console.log(`secret scan: ${scanned} files, ${findings} finding(s), ${allowed} allow-listed`);
process.exit(findings ? 1 : 0);
