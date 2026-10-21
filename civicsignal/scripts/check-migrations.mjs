#!/usr/bin/env node
// Release-safety check for db/migrations (CI runs it; docs/DEPLOYMENT.md, "Database migrations").
//
//   node scripts/check-migrations.mjs            # check
//   node scripts/check-migrations.mjs --lock     # record reviewed new migrations in db/migrations.lock
//
// db/migrations.lock holds the SHA-256 of every reviewed migration, the same checksum the runner stores in
// schema_migrations. It works on any branch, without git history.
// 1. Naming and order: NNNN_lower_snake.sql, numbers contiguous from 0001.
// 2. Immutability: every locked migration still exists and still matches its checksum (the runner refuses an edited
//    file at deploy time; this catches it before merge).
// 3. Expand/contract: a migration not yet in the lock may not contain destructive or rewrite-heavy statements
//    (DROP TABLE/COLUMN, TRUNCATE, RENAME, column type change, SET NOT NULL, DELETE/UPDATE without WHERE) unless that
//    line or the line above carries `-- migration-safety: <reason>`, stating why the previous release keeps working
//    and how to recover. Locked migrations are not re-checked: they are immutable and may already be applied.
// 4. CI fails while a migration is not in the lock, so adding one to the lock is an explicit, reviewed step.
// Prints file names and rule names only.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, 'db', 'migrations');
const lockPath = join(root, 'db', 'migrations.lock');
const update = process.argv.includes('--lock');
const problems = [];

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
files.forEach((f, i) => {
  const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) problems.push(`${f}: name must be NNNN_lower_snake.sql`);
  else if (Number(m[1]) !== i + 1) problems.push(`${f}: expected number ${String(i + 1).padStart(4, '0')} (numbers must be contiguous)`);
});

const sha = (f) => createHash('sha256').update(readFileSync(join(dir, f), 'utf8')).digest('hex');
const lock = new Map();
try {
  for (const line of readFileSync(lockPath, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+\.sql)$/.exec(line.trim());
    if (m) lock.set(m[2], m[1]);
  }
} catch { /* no lock yet: every migration is new */ }

for (const [f, sum] of lock) {
  if (!files.includes(f)) problems.push(`${f}: locked but missing (applied migrations are permanent)`);
  else if (sha(f) !== sum) problems.push(`${f}: changed after it was locked (applied migrations are immutable; add a new migration instead)`);
}

const RULES = [
  ['drop-table', /\bDROP\s+TABLE\b/i],
  ['drop-column', /\bDROP\s+COLUMN\b/i],
  ['truncate', /\bTRUNCATE\b/i],
  ['rename', /\bRENAME\s+(COLUMN\s+|TO\b)/i],
  ['column-type-change', /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i],
  ['set-not-null', /\bSET\s+NOT\s+NULL\b/i],
  ['delete-without-where', /\bDELETE\s+FROM\s+[\w.]+\s*;/i],
  ['update-without-where', /^(?!.*\bWHERE\b).*\bUPDATE\s+[\w.]+\s+SET\b.*;\s*$/i],
];
const fresh = files.filter((f) => !lock.has(f));
for (const f of fresh) {
  const lines = readFileSync(join(dir, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/--.*$/, '');
    for (const [rule, re] of RULES) {
      if (!re.test(code)) continue;
      const justified = [line, lines[i - 1] ?? ''].some((l) => /--\s*migration-safety:\s*\S/.test(l));
      if (!justified) problems.push(`${f}:${i + 1}: ${rule} needs a "-- migration-safety: <reason>" comment (expand/contract, docs/DEPLOYMENT.md)`);
    }
  });
}

if (update && !problems.length) {
  const header = '# SHA-256 of each reviewed migration (scripts/check-migrations.mjs). Never edit a locked migration; add a new one.\n';
  writeFileSync(lockPath, header + files.map((f) => `${sha(f)}  ${f}`).join('\n') + '\n');
  console.log(`locked ${files.length} migrations (${fresh.length} new)`);
  process.exit(0);
}
if (fresh.length && !update) problems.push(`not yet reviewed and locked: ${fresh.join(', ')} (run node scripts/check-migrations.mjs --lock after review)`);
console.log(`migrations: ${files.length} files, ${lock.size} locked, ${fresh.length} new`);
for (const p of problems) console.log(`problem: ${p}`);
process.exit(problems.length ? 1 : 0);
