#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs
 *
 * Black-box smoke test for the CricketStudio MCP server. Spawns
 * `tsx src/server.ts`, drives it over stdio with newline-delimited
 * JSON-RPC (the same transport an MCP client uses), and asserts that:
 *
 *   - initialize returns serverInfo.name === "cricketstudio"
 *   - tools/list returns the full catalog (every TOOL has a handler)
 *   - one tools/call per tool returns a non-error payload
 *
 * No MCP client needed. Exit code 0 = all green, 1 = any failure.
 *
 * Run: `npm run smoke`
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SERVER = resolve(ROOT, 'src', 'server.ts');

// Representative call per tool. Discovery tools first so we can pull
// real keys (slug / trendId) out of their responses for the rest.
const CALLS = [
  ['get_dataset_summary', {}],
  ['search_players', { query: 'kohli', limit: 3 }],
  ['get_player_profile', { playerSlug: 'virat-kohli' }],
  ['get_player_pillar', { playerSlug: 'virat-kohli', pillar: 'P3' }],
  ['list_atomic_claims', { team: 'Royal Challengers Bengaluru', limit: 5 }],
  ['get_team_profile', { teamSlug: 'rcb' }],
  ['get_venue_hub', { venueSlug: 'wankhede-stadium' }],
  ['get_standings', {}],
  ['list_trends', { limit: 5 }],
  ['get_trend', { trendId: 'cond-slow-pp-chase' }],
  ['get_player_h2h', { batterSlug: 'cameron-green', bowlerSlug: 'rashid-khan' }],
  ['get_team_h2h', { teamSlugA: 'mi', teamSlugB: 'csk' }],
  ['get_season_stats', { sortBy: 'runs', limit: 3 }],
  ['compare_players', { playerSlugs: ['virat-kohli', 'jasprit-bumrah'] }],
  ['get_fielding_stats', { limit: 3 }],
  // MLC
  ['get_mlc_dataset_summary', {}],
  ['search_mlc_players', { query: 'du plessis', limit: 3 }],
  ['get_mlc_player_profile', { playerSlug: 'f-du-plessis' }],
  ['get_mlc_team_profile', { teamSlug: 'texas-super-kings' }],
  ['list_mlc_matches', { limit: 5 }],
  ['get_mlc_match', { matchId: '1381361' }],
  ['get_mlc_match_claim', { matchId: '1381361', kind: 'top-batter' }],
  ['list_mlc_leaderboards', { aspect: 'orange-cap', limit: 5 }],
];

function send(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const child = spawn('npx', ['tsx', SERVER], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

  const responses = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) responses.set(msg.id, msg);
      } catch {
        /* ignore non-JSON noise */
      }
    }
  });

  // Handshake.
  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

  let id = 100;
  const callIds = [];
  for (const [name, args] of CALLS) {
    const callId = id++;
    callIds.push([callId, name]);
    send(child, { jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } });
  }

  // Wait for all expected ids (init, list, every call) or time out.
  const expected = new Set([1, 2, ...callIds.map(([cid]) => cid)]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ([...expected].every((e) => responses.has(e))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdin.end();
  child.kill();

  const failures = [];

  // initialize
  const init = responses.get(1);
  if (init?.result?.serverInfo?.name !== 'cricketstudio') {
    failures.push(`initialize: serverInfo.name = ${JSON.stringify(init?.result?.serverInfo?.name)} (want "cricketstudio")`);
  }

  // tools/list — every advertised tool must have a smoke call covering it.
  const list = responses.get(2);
  const advertised = (list?.result?.tools ?? []).map((t) => t.name);
  if (advertised.length === 0) failures.push('tools/list: returned no tools');
  const covered = new Set(CALLS.map(([n]) => n));
  for (const t of advertised) {
    if (!covered.has(t)) failures.push(`tools/list advertises "${t}" but smoke test has no call for it`);
  }

  // Each call: response present + payload is not an error object.
  for (const [cid, name] of callIds) {
    const res = responses.get(cid);
    if (!res) { failures.push(`${name}: no response`); continue; }
    if (res.error) { failures.push(`${name}: JSON-RPC error ${JSON.stringify(res.error)}`); continue; }
    const text = res.result?.content?.[0]?.text;
    if (!text) { failures.push(`${name}: empty content`); continue; }
    let payload;
    try { payload = JSON.parse(text); } catch { failures.push(`${name}: content not JSON`); continue; }
    if (payload.error) { failures.push(`${name}: payload error "${payload.error}" — ${payload.message ?? ''}`); continue; }
    if (!payload.dataAsOf) failures.push(`${name}: missing dataAsOf`);
    console.log(`  ✓ ${name.padEnd(22)} ${payload.canonicalUrl ?? ''}`);
  }

  console.log('');
  if (failures.length) {
    console.error('SMOKE TEST FAILED:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`SMOKE TEST PASSED — ${advertised.length} tools advertised, ${callIds.length} calls green.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
