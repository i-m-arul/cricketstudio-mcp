#!/usr/bin/env node
/**
 * scripts/validate-snapshot.mjs — MOAT CONTENT GATE
 *
 * Runs in CI on every push/PR and locally before any commit to the public repo.
 * Three independent checks — ALL must pass:
 *
 *   1. FILE ALLOWLIST  — only the 20 known snapshot filenames are permitted.
 *                        Any unexpected file (e.g. a .ts source, a raw CSV, a
 *                        config) is an immediate hard failure.
 *
 *   2. SCHEMA ALLOWLIST — each known file has a set of permitted top-level keys.
 *                         Any key not on the list is treated as a potential leak
 *                         of an internal field. New public fields must be
 *                         explicitly added here before they can ship.
 *
 *   3. STRING DENYLIST — banned substrings that indicate raw event arrays,
 *                        internal taxonomy, or upstream vendor names. Kept in
 *                        lockstep with the private monorepo's validate-mcp-snapshot.mjs.
 *
 * Usage:
 *   node scripts/validate-snapshot.mjs              # checks data/snapshot/
 *   node scripts/validate-snapshot.mjs --dir <path> # checks an incoming directory
 *
 * Exit 0 = clean, 1 = leak detected.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Allow --dir <path> override for checking incoming snapshots before applying
const dirFlagIdx = process.argv.indexOf('--dir');
const SNAPSHOT_DIR = dirFlagIdx !== -1
  ? resolve(process.argv[dirFlagIdx + 1])
  : resolve(PKG_ROOT, 'data', 'snapshot');

// ── 1. FILE ALLOWLIST ────────────────────────────────────────────────────────
// ONLY these filenames may exist in data/snapshot/. Anything else = hard fail.
const ALLOWED_FILES = new Set([
  'meta.json',
  'metadata.json',
  'players.json',
  'season-stats.json',
  'standings.json',
  'matches.json',
  'trends.json',
  'h2h.json',
  'team-h2h.json',
  'venues.json',
  'teams.json',
  'ipl-historical.json',
  'graph.json',
  'research.json',
  // MLC (2023–2026)
  'mlc.json',
  'mlc-players.json',
  'mlc-matches.json',
  'mlc-leaderboards.json',
  'mlc-league.json',
  'mlc-teams.json',
  // WPL (2022/23–2025/26)
  'wpl.json',
  'wpl-players.json',
  'wpl-leaderboards.json',
  'wpl-league.json',
  'wpl-teams.json',
  // ICC Men's T20 World Cup
  't20wc.json',
  't20wc-players.json',
  't20wc-leaderboards.json',
  't20wc-league.json',
  't20wc-teams.json',
  // BBL (2011/12–2025/26)
  'bbl.json',
  'bbl-players.json',
  'bbl-leaderboards.json',
  'bbl-league.json',
  'bbl-teams.json',
  // PSL (2016–2026)
  'psl.json',
  'psl-players.json',
  'psl-leaderboards.json',
  'psl-league.json',
  'psl-teams.json',
]);

// ── 2. SCHEMA ALLOWLIST ──────────────────────────────────────────────────────
// Top-level keys permitted in each file. Arrays: the keys of each element.
// A file not listed here is still checked by the denylist (step 3) but not
// schema-validated — add it when you know its structure.
//
// How to read: null = file is a JSON array, check element keys instead.
//              Set  = file is a JSON object, these are the only allowed keys.
const TOP_LEVEL_KEYS = {
  'meta.json': new Set(['builtAt', 'version', 'mode', 'corpus', 'counts']),
  'metadata.json': new Set(['generatedAt', 'bundler', 'counts', 'notes']),
  'venues.json': null, // array — element keys checked below
  'teams.json': null,
  'standings.json': null,
  'matches.json': null,
  'trends.json': null,
  'research.json': null,
  'mlc-league.json': new Set([
    'v', 'code', 'displayName', 'format', 'seasons', 'teams', 'venues',
    'playerCount', 'totalMatches', 'seasonBreakdown', 'crossTeamMoves',
    'generatedAt', 'ballsCaptured', 'leaderboardAspects',
  ]),
  'mlc-teams.json': null,
  'wpl-league.json': new Set([
    'v', 'code', 'displayName', 'format', 'seasons', 'teams', 'venues',
    'playerCount', 'totalMatches', 'seasonBreakdown', 'crossTeamMoves',
    'generatedAt', 'ballsCaptured', 'leaderboardAspects',
  ]),
  'wpl-teams.json': null,
  't20wc-league.json': new Set([
    'v', 'code', 'displayName', 'format', 'seasons', 'teams', 'venues',
    'playerCount', 'totalMatches', 'seasonBreakdown', 'crossTeamMoves',
    'generatedAt', 'ballsCaptured', 'leaderboardAspects',
  ]),
  't20wc-teams.json': null,
  'bbl-league.json': new Set([
    'v', 'code', 'displayName', 'format', 'seasons', 'teams', 'venues',
    'playerCount', 'totalMatches', 'seasonBreakdown', 'crossTeamMoves',
    'generatedAt', 'ballsCaptured', 'leaderboardAspects',
  ]),
  'bbl-teams.json': null,
  'psl-league.json': new Set([
    'v', 'code', 'displayName', 'format', 'seasons', 'teams', 'venues',
    'playerCount', 'totalMatches', 'seasonBreakdown', 'crossTeamMoves',
    'generatedAt', 'ballsCaptured', 'leaderboardAspects',
  ]),
  'psl-teams.json': null,
};

// Allowed keys inside array elements for each file
const ELEMENT_KEYS = {
  'venues.json': new Set(['slug', 'name', 'city', 'country', 'lat', 'lng', 'matchCount', 'canonicalUrl', 'geo']),
  'teams.json': new Set(['code', 'name', 'slug', 'wikidataId', 'wikidataQid', 'canonicalUrl']),
  'standings.json': new Set([
    'teamCode', 'teamName', 'slug', 'played', 'won', 'lost', 'noResult',
    'points', 'nrr', 'runsFor', 'runsAgainst', 'oversFaced', 'oversBowled', 'canonicalUrl',
  ]),
  'matches.json': new Set([
    'id', 'home', 'homeName', 'away', 'awayName', 'date', 'startingAt', 'venue', 'status',
    'result', 'toss', 'homeScore', 'awayScore', 'playerOfMatch', 'canonicalUrl',
    'elected',
  ]),
  'trends.json': new Set([
    'id', 'category', 'headline', 'summary', 'dataPoints', 'sampleSize',
    'computedAt', 'dataWindow', 'canonicalUrl',
    'kind', 'tease', 'bigStat', 'hook', 'detail', 'numbers', 'tag',
  ]),
  'research.json': new Set([
    'id', 'title', 'summary', 'publishedAt', 'dataWindow', 'keyFindings',
    'methodology', 'canonicalUrl', 'tags',
    'series', 'seriesLabel', 'path', 'status', 'provenance', 'license', 'leagueContext',
  ]),
  'mlc-teams.json': new Set([
    'slug', 'name', 'shortName', 'homeCity', 'canonicalUrl',
    'v', 'leagueCode', 'seasons', 'firstSeason', 'lastSeason', 'matchCount', 'generatedAt',
  ]),
  'wpl-teams.json': new Set([
    'v', 'leagueCode', 'slug', 'name', 'seasons', 'firstSeason', 'lastSeason', 'matchCount', 'generatedAt',
  ]),
  't20wc-teams.json': new Set([
    'v', 'leagueCode', 'slug', 'name', 'seasons', 'firstSeason', 'lastSeason', 'matchCount', 'generatedAt',
  ]),
  'bbl-teams.json': new Set([
    'v', 'leagueCode', 'slug', 'name', 'seasons', 'firstSeason', 'lastSeason', 'matchCount', 'generatedAt',
  ]),
  'psl-teams.json': new Set([
    'v', 'leagueCode', 'slug', 'name', 'seasons', 'firstSeason', 'lastSeason', 'matchCount', 'generatedAt',
  ]),
};

// ── 3. STRING DENYLIST ───────────────────────────────────────────────────────
const BANNED = [
  { re: /"wicketEvents"/i,    why: 'raw ball-event array (wicketEvents)' },
  { re: /"sixEvents"/i,       why: 'raw ball-event array (sixEvents)' },
  { re: /"fourEvents"/i,      why: 'raw ball-event array (fourEvents)' },
  { re: /"catchEvents"/i,     why: 'raw ball-event array (catchEvents)' },
  { re: /"runOutEvents"/i,    why: 'raw ball-event array (runOutEvents)' },
  { re: /"inningsLog"/i,      why: 'per-innings diagnostic log' },
  { re: /"spellLog"/i,        why: 'per-spell diagnostic log' },
  { re: /"positionVariability"/i, why: 'internal diagnostic field' },
  { re: /sportmonks/i,        why: 'upstream vendor name (sportmonks)' },
  { re: /cricketmind/i,       why: 'internal data-layer name (CricketMind)' },
  { re: /"metricId"/i,        why: 'internal claim taxonomy (metricId)' },
  { re: /"tier"\s*:/i,        why: 'internal player-importance ranking (tier)' },
  { re: /"schemaUrl"/i,       why: 'internal schema url' },
  { re: /"idSystems"/i,       why: 'internal id-system map' },
  { re: /"espncricinfoId"/i,  why: 'bare external id — use espncricinfoUrl (full URL)' },
  { re: /cs_(player|franchise|match|venue|team|season|league)_/i, why: 'internal cs_* canonical id' },
  // upstream numeric entity ids (Sportmonks team/match/toss numeric keys)
  { re: /"teamId"\s*:/i,       why: 'upstream numeric team id (teamId) — must be stripped from standings' },
  { re: /"winnerId"\s*:/i,     why: 'upstream numeric winner id (winnerId) — must be stripped from matches' },
  { re: /"tossWinnerId"\s*:/i, why: 'upstream numeric toss-winner id (tossWinnerId) — must be stripped from matches' },
  // upstream fixture numeric references in claim strings
  { re: /\(fixture \d+\)/i,   why: 'upstream fixture numeric id in claim string — scrubFixtureIds() must strip these' },
  { re: / for fixture \d+/i,  why: 'upstream fixture numeric id in claim string — scrubFixtureIds() must strip these' },
  // internal path references in public strings
  { re: /lib\/setu\//i,        why: 'internal algorithm path (lib/setu/) in public string' },
  { re: /lib\/agents\//i,      why: 'internal algorithm path (lib/agents/) in public string' },
  // Source-code leak guards — catches accidental .ts / .js copies
  { re: /import\s+\{[^}]+\}\s+from\s+['"]/, why: 'ES import statement — looks like source code' },
  { re: /export\s+(const|function|class|default)\s/i, why: 'ES export statement — looks like source code' },
  { re: /require\(['"][@./]/, why: 'CommonJS require — looks like source code' },
  { re: /process\.env\./,     why: 'process.env access — looks like source code or config' },
];

// ── Runner ───────────────────────────────────────────────────────────────────
if (!existsSync(SNAPSHOT_DIR)) {
  console.error(`✗ snapshot directory not found: ${SNAPSHOT_DIR}`);
  process.exit(1);
}

const allFiles = readdirSync(SNAPSHOT_DIR);
const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));
const nonJson = allFiles.filter((f) => !f.endsWith('.json'));
const errors = [];
const warnings = [];

// Check 1a: no non-JSON files
for (const f of nonJson) {
  errors.push(`UNEXPECTED FILE: ${f} — only .json files are allowed in data/snapshot/`);
}

// Check 1b: no unknown JSON filenames
for (const f of jsonFiles) {
  if (!ALLOWED_FILES.has(f)) {
    errors.push(`UNKNOWN FILE: ${f} — not in the allowed-file list (potential source leak)`);
  }
}

// Check 1c: file size sanity (>15 MB is suspicious for any single snapshot file)
const MAX_FILE_SIZE = 15 * 1024 * 1024;
for (const f of jsonFiles) {
  const size = statSync(join(SNAPSHOT_DIR, f)).size;
  if (size > MAX_FILE_SIZE) {
    errors.push(`OVERSIZE: ${f} is ${(size / 1024 / 1024).toFixed(1)} MB — exceeds 15 MB safety limit`);
  }
}

// Check 1d: valid JSON
const parsed = {};
for (const f of jsonFiles) {
  const text = readFileSync(join(SNAPSHOT_DIR, f), 'utf8');
  try {
    parsed[f] = { text, data: JSON.parse(text) };
  } catch (e) {
    errors.push(`INVALID JSON: ${f} — ${e.message}`);
  }
}

// Check 2: schema allowlist
for (const [f, allowed] of Object.entries(TOP_LEVEL_KEYS)) {
  if (!parsed[f]) continue;
  const { data } = parsed[f];

  if (allowed === null) {
    // Array file — check element keys
    const elemAllowed = ELEMENT_KEYS[f];
    if (!elemAllowed) continue;
    if (!Array.isArray(data)) {
      errors.push(`SCHEMA: ${f} — expected a JSON array`);
      continue;
    }
    const unknownKeys = new Set();
    for (const el of data) {
      for (const k of Object.keys(el)) {
        if (!elemAllowed.has(k)) unknownKeys.add(k);
      }
    }
    for (const k of unknownKeys) {
      errors.push(`SCHEMA: ${f} — unknown element key "${k}" (not in allowlist — add it if intentional)`);
    }
  } else {
    // Object file — check top-level keys
    if (Array.isArray(data) || typeof data !== 'object') {
      errors.push(`SCHEMA: ${f} — expected a JSON object`);
      continue;
    }
    for (const k of Object.keys(data)) {
      if (!allowed.has(k)) {
        errors.push(`SCHEMA: ${f} — unknown top-level key "${k}" (not in allowlist — add it if intentional)`);
      }
    }
  }
}

// Check 3: string denylist
for (const f of jsonFiles) {
  if (!parsed[f]) continue;
  const { text } = parsed[f];
  for (const { re, why } of BANNED) {
    const m = text.match(re);
    if (m) {
      const i = text.indexOf(m[0]);
      const snippet = text.slice(Math.max(0, i - 20), i + 60).replace(/\s+/g, ' ');
      errors.push(`BANNED in ${f}: ${why}  …${snippet}…`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (!jsonFiles.length) {
  console.error('✗ no snapshot files found');
  process.exit(1);
}

if (errors.length) {
  console.error(`\n✗ SNAPSHOT CONTENT GATE FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ snapshot content gate PASSED`);
console.log(`  ${jsonFiles.length} files · file allowlist · schema allowlist · denylist — all clean`);
if (warnings.length) {
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
}
process.exit(0);
