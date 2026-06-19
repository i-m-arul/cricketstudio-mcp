#!/usr/bin/env node
/**
 * bump-version.mjs
 *
 * Called by the private monorepo's sync workflow after dropping fresh
 * snapshot files into data/snapshot/. Reads meta.json to derive the
 * new corpus counts, bumps package.json (minor bump), and rewrites the
 * version comment in src/index.ts.
 *
 * Usage:
 *   node scripts/bump-version.mjs [--patch]
 *
 * Flags:
 *   --patch   Force a patch bump (x.y.Z) instead of the default minor (x.Y.0).
 *             Use for data corrections; use the default minor for new seasons.
 *
 * Exit 0 = success, 1 = error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Args ────────────────────────────────────────────────────────────────────
const patch = process.argv.includes('--patch');

// ── Read current state ───────────────────────────────────────────────────────
const pkgPath = resolve(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const metaPath = resolve(ROOT, 'data', 'snapshot', 'meta.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

// ── Bump version ─────────────────────────────────────────────────────────────
const [major, minor, patchNum] = pkg.version.split('.').map(Number);
const newVersion = patch
  ? `${major}.${minor}.${patchNum + 1}`
  : `${major}.${minor + 1}.0`;

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json: ${pkg.version.replace(newVersion, '[old]')} → ${newVersion}`);

// ── Update version comment in src/index.ts ───────────────────────────────────
const idxPath = resolve(ROOT, 'src', 'index.ts');
let idx = readFileSync(idxPath, 'utf8');

// Replace version tag in the opening JSDoc (e.g. "v1.2.0")
idx = idx.replace(/\(v\d+\.\d+\.\d+\)/, `(v${newVersion})`);

// Replace corpus counts line — format: "N tools covering:" or "N players, N matches"
// Update the match/player counts from meta if present
const { counts } = meta;
if (counts) {
  const iplMatches = counts.matches ?? '?';
  const mlcMatches = counts.mlc?.matches ?? '?';
  const players = counts.players ?? '?';
  // Replace the corpus-summary line in the JSDoc if it exists
  idx = idx.replace(
    /\/\/\s*corpus:.*$/m,
    `// corpus: ${players} IPL-2026 players · ${iplMatches} IPL matches · ${mlcMatches} MLC matches`
  );
}

writeFileSync(idxPath, idx);
console.log(`src/index.ts: version comment updated to v${newVersion}`);

// ── Print summary ─────────────────────────────────────────────────────────────
console.log('\nSnapshot meta:');
console.log(`  builtAt  : ${meta.builtAt}`);
console.log(`  version  : ${meta.version}`);
console.log(`  players  : ${meta.corpus?.players ?? meta.counts?.players}`);
console.log(`  matches  : ${meta.corpus?.matches ?? meta.counts?.matches}`);
console.log(`  deliveries: ${meta.corpus?.deliveries ?? '—'}`);
console.log(`\nNew package version: ${newVersion}`);
