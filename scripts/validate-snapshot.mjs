#!/usr/bin/env node
/**
 * scripts/validate-snapshot.mjs — MOAT CONTENT GATE (public repo copy).
 *
 * Runs in this repo's CI on every push/PR. Scans data/snapshot/*.json for
 * banned substrings and exits non-zero on any hit. This is the QA layer that
 * must pass before the package is published (operator rule, 2026-06-11): the
 * original §27 gate only checked file PATHS, never CONTENT, which let a
 * rewritten builder leak raw ball arrays + vendor names + internal taxonomies
 * into the npm package. This closes that hole at the public-repo boundary.
 *
 * Keep BANNED in lockstep with the private monorepo's scripts/validate-mcp-snapshot.mjs.
 *
 * Usage: node scripts/validate-snapshot.mjs   (exit 0 clean, 1 = leak)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = resolve(PKG_ROOT, 'data', 'snapshot');

const BANNED = [
  { re: /"wicketEvents"/i, why: 'raw ball-event array (wicketEvents)' },
  { re: /"sixEvents"/i, why: 'raw ball-event array (sixEvents)' },
  { re: /"fourEvents"/i, why: 'raw ball-event array (fourEvents)' },
  { re: /"catchEvents"/i, why: 'raw ball-event array (catchEvents)' },
  { re: /"runOutEvents"/i, why: 'raw ball-event array (runOutEvents)' },
  { re: /"inningsLog"/i, why: 'per-innings diagnostic log (inningsLog)' },
  { re: /"spellLog"/i, why: 'per-spell diagnostic log (spellLog)' },
  { re: /"positionVariability"/i, why: 'internal diagnostic (positionVariability)' },
  { re: /sportmonks/i, why: 'upstream vendor name / CDN id leak (sportmonks)' },
  { re: /cricketmind/i, why: 'internal data-layer name (CricketMind)' },
  { re: /"metricId"/i, why: 'internal claim taxonomy (metricId)' },
  { re: /"tier"\s*:/i, why: 'internal player-importance ranking (tier)' },
  { re: /"schemaUrl"/i, why: 'internal schema url' },
  { re: /"idSystems"/i, why: 'internal id-system map' },
  { re: /"espncricinfoId"/i, why: 'bare external id (espncricinfoId) — use the full URL' },
  { re: /cs_(player|franchise|match|venue|team|season|league)_/i, why: 'internal cs_* canonical id' },
];
// Allowed (do NOT flag): espncricinfoUrl (full URL), Cricsheet / CC BY (required attribution).

const files = existsSync(SNAPSHOT_DIR) ? readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json')) : [];
const errors = [];
for (const f of files) {
  const text = readFileSync(join(SNAPSHOT_DIR, f), 'utf8');
  for (const { re, why } of BANNED) {
    const m = text.match(re);
    if (m) {
      const i = text.indexOf(m[0]);
      errors.push(`${f}: BANNED — ${why}  …${text.slice(Math.max(0, i - 20), i + 60).replace(/\s+/g, ' ')}…`);
    }
  }
}
if (!files.length) { console.error('✗ no snapshot files found'); process.exit(1); }
if (errors.length) {
  console.error(`✗ snapshot content gate FAILED — ${errors.length} leak(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`✓ snapshot content gate PASSED — ${files.length} files, no moat leakage.`);
process.exit(0);
