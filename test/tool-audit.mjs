/**
 * tool-audit.mjs — calls all 29 MCP tools with valid args and classifies
 * each response as DATA / POINTER / EMPTY / ERROR. Empirical ground truth
 * for "is the MCP actually returning data."
 *
 * Run: node test/tool-audit.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = (f) => JSON.parse(readFileSync(join(ROOT, 'data/snapshot', f), 'utf8'));
const asArr = (x) => Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []);

// ── discover valid keys ──
const players = asArr(SNAP('players.json'));
const mlcPlayers = asArr(SNAP('mlc-players.json'));
const matches = asArr(SNAP('matches.json'));
const trends = (() => { const t = SNAP('trends.json'); return t.trends || asArr(t); })();
const teams = asArr(SNAP('teams.json'));
const venues = asArr(SNAP('venues.json'));
const mlcMatches = asArr(SNAP('mlc-matches.json'));
const mlcTeams = asArr(SNAP('mlc-teams.json'));
const h2h = (() => { const h = SNAP('h2h.json'); return h.pairs || asArr(h); })();

const pSlug = players.find(p => /kohli/i.test(p.fullName || ''))?.slug || players[0]?.slug;
const pSlug2 = players.find(p => /bumrah/i.test(p.fullName || ''))?.slug || players[1]?.slug;
const mlcPSlug = mlcPlayers[0]?.slug;
const matchId = String(matches[0]?.id ?? '');
const trendId = trends[0]?.id;
const teamA = teams[0]?.slug || 'mi';
const teamB = teams[1]?.slug || 'csk';
const venueSlug = venues[0]?.slug;
const mlcMatchId = String(mlcMatches[0]?.matchId ?? '');
const mlcTeamSlug = mlcTeams[0]?.slug;
const h2hPair = h2h[0] || {};
const batterSlug = h2hPair.batterSlug || pSlug;
const bowlerSlug = h2hPair.bowlerSlug || pSlug2;
const mlcClaimKind = mlcMatches[0]?.claims?.[0]?.kind || 'recap';

// ── test matrix: tool name → args ──
const TESTS = [
  ['get_dataset_summary', {}],
  ['search_players', { query: 'kohli' }],
  ['get_player_profile', { playerSlug: pSlug }],
  ['get_player_pillar', { playerSlug: pSlug, pillar: 'P1' }],
  ['get_standings', {}],
  ['get_season_stats', { sortBy: 'runs' }],
  ['get_match_state', { matchId }],
  ['get_match_recap', { matchId }],
  ['list_fixtures', {}],
  ['get_trend', { trendId }],
  ['list_trends', {}],
  ['get_player_h2h', { batterSlug, bowlerSlug }],
  ['get_team_profile', { teamSlug: teamA }],
  ['get_venue_hub', { venueSlug }],
  ['list_atomic_claims', {}],
  ['get_team_h2h', { teamSlugA: teamA, teamSlugB: teamB }],
  ['get_partnerships', { playerSlug: pSlug }],
  ['compare_players', { playerSlugs: [pSlug, pSlug2] }],
  ['get_dismissal_analysis', { playerSlug: pSlug }],
  ['get_fielding_stats', {}],
  ['get_mlc_dataset_summary', {}],
  ['search_mlc_players', { query: mlcPSlug?.split('-')[1] || 'a' }],
  ['get_mlc_player_profile', { playerSlug: mlcPSlug }],
  ['get_mlc_team_profile', { teamSlug: mlcTeamSlug }],
  ['get_mlc_match', { matchId: mlcMatchId }],
  ['get_mlc_match_claim', { matchId: mlcMatchId, kind: mlcClaimKind }],
  ['list_mlc_matches', {}],
  ['list_mlc_leaderboards', { aspect: 'orange-cap' }],
  ['get_ipl_leaderboard', { aspect: 'orange-cap' }],
];

// ── classify a tool response ──
const POINTER_RX = /at the canonical url|server-rendered at|full .* (is )?at|not bundled|live .* at the canonical/i;
const NOISE_KEYS = new Set(['canonicalUrl', 'dataAsOf', 'note', 'refreshFrequency', 'provenance', 'hint', 'window']);

function classify(obj) {
  if (obj == null) return 'NULL';
  if (obj.error) return 'ERROR';
  // substantive keys = anything not in NOISE_KEYS
  const keys = Object.keys(obj).filter(k => !NOISE_KEYS.has(k));
  // collect substantive values
  let hasData = false, allEmpty = true;
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) { if (v.length > 0) { hasData = true; allEmpty = false; } }
    else if (v && typeof v === 'object') { if (Object.keys(v).length > 0) { hasData = true; allEmpty = false; } }
    else if (typeof v === 'number') { hasData = true; allEmpty = false; }
    else if (typeof v === 'string' && v.length > 0 && k !== 'status' && k !== 'season' && k !== 'champion') { hasData = true; allEmpty = false; }
    else if (typeof v === 'string') { /* status/season/champion = metadata */ }
  }
  // pointer detection: note text says "go to the URL" AND no substantive data arrays/objects
  const noteText = String(obj.note ?? '');
  const isPointer = POINTER_RX.test(noteText) && !hasData;
  if (isPointer) return 'POINTER';
  if (keys.length === 0 || allEmpty) return 'EMPTY';
  return 'DATA';
}

// ── run all tools through one stdio session ──
function runSession() {
  return new Promise((resolve) => {
    const child = spawn('node', [join(ROOT, 'dist/index.js')], {
      env: { ...process.env, CRICKETSTUDIO_NO_TELEMETRY: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => resolve(out));

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    TESTS.forEach(([name, args], i) => {
      send({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: args } });
    });
    setTimeout(() => child.stdin.end(), 500);
  });
}

const raw = await runSession();
const byId = {};
for (const line of raw.split('\n').filter(Boolean)) {
  try { const m = JSON.parse(line); if (m.id >= 100) byId[m.id] = m; } catch {}
}

let data = 0, pointer = 0, empty = 0, error = 0, missing = 0;
const rows = [];
TESTS.forEach(([name], i) => {
  const m = byId[100 + i];
  if (!m) { rows.push([name, 'NO-RESPONSE', 0]); missing++; return; }
  const txt = m.result?.content?.[0]?.text ?? '';
  let obj = null; try { obj = JSON.parse(txt); } catch { obj = { _raw: txt }; }
  const verdict = m.result?.isError ? 'ERROR' : classify(obj);
  const bytes = txt.length;
  rows.push([name, verdict, bytes]);
  if (verdict === 'DATA') data++;
  else if (verdict === 'POINTER') pointer++;
  else if (verdict === 'EMPTY') empty++;
  else error++;
});

console.log('TOOL'.padEnd(26), 'VERDICT'.padEnd(12), 'BYTES');
console.log('-'.repeat(50));
for (const [name, verdict, bytes] of rows) {
  const flag = verdict === 'DATA' ? '✅' : verdict === 'POINTER' ? '🔗' : verdict === 'EMPTY' ? '⚠️ ' : '❌';
  console.log(flag, name.padEnd(24), verdict.padEnd(12), bytes);
}
console.log('-'.repeat(50));
console.log(`DATA: ${data}  POINTER: ${pointer}  EMPTY: ${empty}  ERROR: ${error}  MISSING: ${missing}  / ${TESTS.length}`);
