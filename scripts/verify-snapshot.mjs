#!/usr/bin/env node
/**
 * scripts/verify-snapshot.mjs — LOCAL SNAPSHOT VERIFICATION + APPLY TOOL
 *
 * Compares an incoming snapshot directory (from the private build pipeline)
 * against the current public snapshot. Shows a human-readable diff before
 * anything is committed to the public repo.
 *
 * This is the HUMAN CHECKPOINT between the private pipeline and the public
 * repo. Run this locally; review the output; only apply if satisfied.
 *
 * Usage:
 *   node scripts/verify-snapshot.mjs --incoming <dir>
 *       Show diff and run all gate checks. Exit 0 = clean, 1 = problems.
 *
 *   node scripts/verify-snapshot.mjs --incoming <dir> --apply [--patch]
 *       After a clean verify, copy files into data/snapshot/, bump version,
 *       and stage for commit. You still run `git commit` manually.
 *
 * Flags:
 *   --incoming <dir>   Path to new snapshot files from the private pipeline
 *   --apply            Copy files + bump version (only runs if verify is clean)
 *   --patch            Use a patch bump (x.y.Z) instead of minor (x.Y.0)
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CURRENT_DIR = resolve(ROOT, 'data', 'snapshot');

// ── Parse args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const incomingIdx = args.indexOf('--incoming');
if (incomingIdx === -1 || !args[incomingIdx + 1]) {
  console.error('Usage: node scripts/verify-snapshot.mjs --incoming <dir> [--apply] [--patch]');
  process.exit(1);
}
const INCOMING_DIR = resolve(args[incomingIdx + 1]);
const APPLY = args.includes('--apply');
const PATCH_BUMP = args.includes('--patch');

if (!existsSync(INCOMING_DIR)) {
  console.error(`✗ Incoming directory not found: ${INCOMING_DIR}`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => n.toLocaleString();
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (a, b) => b === 0 ? '—' : `${a > b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%`;

function readJson(dir, file) {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ── Section header ────────────────────────────────────────────────────────────
const hr = (title) => console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1: CONTENT GATE — run validate-snapshot.mjs on the incoming dir
// ═════════════════════════════════════════════════════════════════════════════
hr('1 / 3  CONTENT GATE (file allowlist · schema · denylist)');
try {
  execSync(
    `node ${join(__dirname, 'validate-snapshot.mjs')} --dir ${INCOMING_DIR}`,
    { stdio: 'inherit' }
  );
} catch {
  console.error('\n✗ Content gate failed — fix the issues above before applying.');
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 2: DIFF REPORT
// ═════════════════════════════════════════════════════════════════════════════
hr('2 / 3  DIFF REPORT');

const incomingFiles = readdirSync(INCOMING_DIR).filter(f => f.endsWith('.json')).sort();
const currentFiles  = readdirSync(CURRENT_DIR).filter(f => f.endsWith('.json')).sort();

const allFiles = [...new Set([...currentFiles, ...incomingFiles])].sort();

console.log('\nFile sizes (current → incoming):');
let anyFileProblem = false;

for (const f of allFiles) {
  const curPath = join(CURRENT_DIR, f);
  const newPath = join(INCOMING_DIR, f);
  const curExists = existsSync(curPath);
  const newExists = existsSync(newPath);

  if (!curExists && newExists) {
    const size = statSync(newPath).size;
    console.log(`  [NEW]     ${f.padEnd(30)} ${kb(size)}`);
    continue;
  }
  if (curExists && !newExists) {
    console.log(`  [REMOVED] ${f.padEnd(30)} ← this file will be DELETED`);
    anyFileProblem = true;
    continue;
  }

  const curSize = statSync(curPath).size;
  const newSize = statSync(newPath).size;
  const ratio = newSize / curSize;
  let flag = '';
  if (ratio > 3)  { flag = '  ⚠ WARNING: >3× size increase'; anyFileProblem = true; }
  if (ratio < 0.3){ flag = '  ⚠ WARNING: <30% of current size'; anyFileProblem = true; }

  const arrow = newSize > curSize ? '↑' : newSize < curSize ? '↓' : '=';
  console.log(`  ${arrow}  ${f.padEnd(30)} ${kb(curSize).padStart(10)} → ${kb(newSize).padStart(10)}  (${pct(newSize, curSize)})${flag}`);
}

// ── Meta counts diff ─────────────────────────────────────────────────────────
console.log('\nCorpus counts (meta.json):');
const curMeta = readJson(CURRENT_DIR, 'meta.json');
const newMeta = readJson(INCOMING_DIR, 'meta.json');

if (curMeta && newMeta) {
  const fields = [
    ['builtAt',          curMeta.builtAt,                   newMeta.builtAt],
    ['version',          curMeta.version,                   newMeta.version],
    ['corpus.matches',   curMeta.corpus?.matches,            newMeta.corpus?.matches],
    ['corpus.deliveries',curMeta.corpus?.deliveries,         newMeta.corpus?.deliveries],
    ['corpus.players',   curMeta.corpus?.players,            newMeta.corpus?.players],
    ['counts.mlc.matches', curMeta.counts?.mlc?.matches,    newMeta.counts?.mlc?.matches],
    ['counts.mlc.players', curMeta.counts?.mlc?.players,    newMeta.counts?.mlc?.players],
    ['counts.iplHistorical.players', curMeta.counts?.iplHistorical?.players, newMeta.counts?.iplHistorical?.players],
    ['counts.iplHistorical.seasons', curMeta.counts?.iplHistorical?.seasons, newMeta.counts?.iplHistorical?.seasons],
  ];
  for (const [label, cur, nw] of fields) {
    if (cur === undefined && nw === undefined) continue;
    const changed = String(cur) !== String(nw);
    const prefix = changed ? '  Δ' : '   ';
    console.log(`${prefix}  ${label.padEnd(35)} ${String(cur ?? '—').padStart(12)} → ${String(nw ?? '—')}`);
  }
}

// ── Standings spot-check ─────────────────────────────────────────────────────
const curStandings = readJson(CURRENT_DIR, 'standings.json');
const newStandings = readJson(INCOMING_DIR, 'standings.json');
if (Array.isArray(curStandings) && Array.isArray(newStandings)) {
  console.log('\nStandings top-3 (current → incoming):');
  const top3new = newStandings.slice(0, 3);
  for (const t of top3new) {
    const old = curStandings.find(x => x.teamCode === t.teamCode);
    const ptsDiff = old ? (t.points !== old.points ? ` (was ${old.points} pts)` : '') : ' [new]';
    console.log(`  ${t.teamCode.padEnd(5)} ${String(t.points).padStart(3)} pts  W${t.won} L${t.lost}${ptsDiff}`);
  }
}

// ── MLC player count spot-check ───────────────────────────────────────────────
const curMlcP = readJson(CURRENT_DIR, 'mlc-players.json');
const newMlcP = readJson(INCOMING_DIR, 'mlc-players.json');
if (Array.isArray(curMlcP) && Array.isArray(newMlcP)) {
  const delta = newMlcP.length - curMlcP.length;
  console.log(`\nMLC players: ${fmt(curMlcP.length)} → ${fmt(newMlcP.length)}  (${delta >= 0 ? '+' : ''}${delta})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 3: VERDICT
// ═════════════════════════════════════════════════════════════════════════════
hr('3 / 3  VERDICT');

if (anyFileProblem) {
  console.log('\n⚠  File size warnings or removals detected (see above).');
  console.log('   Review carefully before applying. Re-run with --apply only if intentional.\n');
} else {
  console.log('\n✓ All checks passed. Snapshot looks clean.\n');
}

if (!APPLY) {
  console.log('Dry run complete. Add --apply to copy files + bump version.');
  process.exit(anyFileProblem ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// APPLY — copy files, bump version, stage
// ═════════════════════════════════════════════════════════════════════════════
console.log('\nApplying snapshot...');
for (const f of incomingFiles) {
  copyFileSync(join(INCOMING_DIR, f), join(CURRENT_DIR, f));
  process.stdout.write(`  copied ${f}\n`);
}

console.log('\nBumping version...');
execSync(
  `node ${join(__dirname, 'bump-version.mjs')} ${PATCH_BUMP ? '--patch' : ''}`,
  { stdio: 'inherit', cwd: ROOT }
);

const newVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const date = new Date().toISOString().slice(0, 10);

console.log('\nBuilding dist/...');
execSync('npm run build', { stdio: 'inherit', cwd: ROOT });

console.log('\nRunning smoke test...');
execSync('npm run smoke', { stdio: 'inherit', cwd: ROOT });

console.log(`
✓ Snapshot applied and verified.

Next steps:
  git add data/snapshot/ package.json src/index.ts dist/
  git commit -m "snapshot refresh ${date} (v${newVersion})"
  git push
`);
