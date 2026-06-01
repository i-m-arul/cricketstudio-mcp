#!/usr/bin/env node
/**
 * index.ts — CricketStudio MCP server entry point (v1.0.0)
 *
 * 29 tools covering:
 *   - IPL 2026 core (player profiles, standings, season stats, trends, H2H, venues, teams)
 *   - IPL historical (18 seasons, Cricsheet corpus) via get_ipl_leaderboard
 *   - Major League Cricket (2023–2026, Cricsheet CC BY 3.0)
 *
 * All data is read from the bundled snapshot at data/snapshot/ via ./snapshot.js.
 * Numbers never pass through an LLM — every numeric value is deterministically
 * computed from ball-by-ball records in the private monorepo before being
 * bundled here.
 *
 * Run:  npx cricketstudio-mcp
 * Docs: https://players.cricketstudio.ai/mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runStartup } from './telemetry.js';
import * as snap from './snapshot.js';

// ─── Paths ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, '..', 'data', 'snapshot');
const SITE = 'https://players.cricketstudio.ai';
const MLC_HUB = `${SITE}/leagues/mlc`;
const IPL_HUB = `${SITE}/leagues/ipl`;

// ─── Snapshot loader helpers (direct reads for files not in snapshot.ts) ─

import { readFileSync, existsSync } from 'node:fs';

function readSnapshotJson<T>(name: string): T | null {
  const p = resolve(SNAPSHOT_DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

// MLC per-file loaders (mirroring server.ts pattern — lazy + memoised)
type MlcPlayer = { slug: string; fullName: string; teamSlugs: string[]; batting: Record<string, unknown>; bowling: Record<string, unknown>; bySeason: Record<string, unknown>; identity: Record<string, unknown> | null };
type MlcTeam = { slug: string; name: string; seasons: string[]; firstSeason: string; lastSeason: string; matchCount: number };
type MlcClaim = { kind: string; kindLabel?: string; atomic: string; headline?: string; subheadline?: string; subject?: unknown; coSubject?: unknown; rows?: unknown; sampleSize?: number | string; sampleUnit?: string };
type MlcMatch = { matchId: string; season: string; startDate: string; matchType?: string; teams: { home: { slug: string; name: string }; away: { slug: string; name: string } }; venue: { name: string }; toss?: unknown; result: { outcome: string; winnerSlug?: string; winMargin?: number | string; winType?: string }; officials?: unknown; playerOfMatch?: unknown[]; innings: Array<{ inningsNumber: number; battingTeamSlug: string; totalRuns: number; totalWickets: number; oversBowled: number }>; attribution: { matchUrl: string }; claims: MlcClaim[] };
type MlcLeague = { displayName?: string; seasons: string[]; teams: unknown[]; venues: unknown[]; playerCount: number; totalMatches: number; seasonBreakdown?: unknown; crossTeamMoves?: unknown; ballsCaptured?: number; leaderboardAspects: Array<{ slug: string; title: string }> };
type MlcLeaderboard = { slug: string; title: string; description?: string; metricLabel?: string; floorNote?: string | null; rows: Array<{ rank: number; slug: string; fullName: string; teamSlugs: string[]; metricValue: number; formatted: string; secondary?: string | null; sampleSize?: string }> };
type PlayerRecord = { slug: string; fullName: string; team: string; role: string; sameAs?: Record<string, string>; headlineClaimId?: string | null; claims: Array<{ id: string; metric: string; value: string; period: string; comparator?: string; sampleSize?: string; computedAt?: string; stale?: boolean; headline?: string; context?: string; pillar?: 'P1' | 'P2' | 'P3' | 'P4' | 'P5'; provenance?: 'live' | 'sample' | 'derived' }> };
type SnapshotMetadata = { generatedAt: string; counts: { players: number; teams: number; venues: number; trends: number; h2hPairs: number; teamH2hPairs?: number; mlc?: { players: number; teams: number; matches: number; leaderboards: number } } };
type Venue = { slug: string; name: string; geo?: { lat: number; lng: number; wikidataQid?: string } };
type Team = { slug: string; name: string; code: string; wikidataQid?: string };
type H2HSummary = { slug: string; batterSlug: string; batterName: string; bowlerSlug: string; bowlerName: string; deliveries?: number; runs?: number; strikeRate?: number; fours?: number; sixes?: number; dotBalls?: number; dismissals?: number };
type TeamH2HRecord = { a: { slug: string; name: string; code: string }; b: { slug: string; name: string; code: string }; matches: number; aWon: number; bWon: number; noResult: number; recent: Array<{ date: string; venue: string; result: string }> };
type IplHistoricalRecord = { leaderboards?: Record<string, unknown[]>; seasons?: unknown[]; records?: unknown };

let _players: Record<string, PlayerRecord> | null = null;
let _teams: Team[] | null = null;
let _venues: Venue[] | null = null;
let _trends: snap.Trend[] | null = null;
let _h2h: H2HSummary[] | null = null;
let _teamH2h: Record<string, TeamH2HRecord> | null = null;
let _metadata: SnapshotMetadata | null = null;
let _seasonStats: Record<string, unknown> | null = null;
let _mlcPlayers: Record<string, MlcPlayer> | null = null;
let _mlcTeams: MlcTeam[] | null = null;
let _mlcMatches: Record<string, MlcMatch> | null = null;
let _mlcLeague: MlcLeague | null = null;
let _mlcLeaderboards: Record<string, MlcLeaderboard> | null = null;
let _iplHistorical: IplHistoricalRecord | null | undefined = undefined;

function players() { if (!_players) _players = readSnapshotJson<Record<string, PlayerRecord>>('players.json') ?? {}; return _players; }
function teams() { if (!_teams) _teams = readSnapshotJson<Team[]>('teams.json') ?? []; return _teams; }
function venues() { if (!_venues) _venues = readSnapshotJson<Venue[]>('venues.json') ?? []; return _venues; }
function trendsList() { if (!_trends) _trends = snap.getTrends(); return _trends; }
function h2hSummaries() { if (!_h2h) _h2h = readSnapshotJson<H2HSummary[]>('h2h.json') ?? []; return _h2h; }
function teamH2h() { if (!_teamH2h) _teamH2h = readSnapshotJson<Record<string, TeamH2HRecord>>('team-h2h.json') ?? {}; return _teamH2h; }
function metadata() { if (!_metadata) _metadata = readSnapshotJson<SnapshotMetadata>('metadata.json') ?? { generatedAt: new Date().toISOString(), counts: { players: 0, teams: 0, venues: 0, trends: 0, h2hPairs: 0 } }; return _metadata; }
function seasonStats() { if (!_seasonStats) _seasonStats = readSnapshotJson<Record<string, unknown>>('season-stats.json') ?? {}; return _seasonStats; }
function mlcPlayers() { if (!_mlcPlayers) _mlcPlayers = readSnapshotJson<Record<string, MlcPlayer>>('mlc-players.json') ?? {}; return _mlcPlayers; }
function mlcTeams() { if (!_mlcTeams) _mlcTeams = readSnapshotJson<MlcTeam[]>('mlc-teams.json') ?? []; return _mlcTeams; }
function mlcMatches() { if (!_mlcMatches) _mlcMatches = readSnapshotJson<Record<string, MlcMatch>>('mlc-matches.json') ?? {}; return _mlcMatches; }
function mlcLeague() { if (!_mlcLeague) _mlcLeague = readSnapshotJson<MlcLeague>('mlc-league.json') ?? { seasons: [], teams: [], venues: [], playerCount: 0, totalMatches: 0, leaderboardAspects: [] }; return _mlcLeague; }
function mlcLeaderboards() { if (!_mlcLeaderboards) _mlcLeaderboards = readSnapshotJson<Record<string, MlcLeaderboard>>('mlc-leaderboards.json') ?? {}; return _mlcLeaderboards; }
function iplHistorical(): IplHistoricalRecord | null {
  if (_iplHistorical !== undefined) return _iplHistorical;
  _iplHistorical = readSnapshotJson<IplHistoricalRecord>('ipl-historical.json');
  return _iplHistorical;
}

// ─── URL helpers ──────────────────────────────────────────────────────

const mlcPlayerUrl = (slug: string) => `${MLC_HUB}/players/${slug}`;
const mlcTeamUrl = (slug: string) => `${MLC_HUB}/teams/${slug}`;
const mlcMatchUrl = (id: string) => `${MLC_HUB}/matches/${id}`;
const mlcMatchClaimUrl = (id: string, kind: string) => `${MLC_HUB}/matches/${id}/c/${kind}`;
const mlcLeaderboardUrl = (aspect: string) => `${MLC_HUB}/leaderboards/${aspect}`;

function dataAsOf(): string {
  try { return statSync(resolve(SNAPSHOT_DIR, 'metadata.json')).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

function ok(payload: Record<string, unknown>, canonicalUrl?: string) {
  const enriched = { ...payload, dataAsOf: dataAsOf(), ...(canonicalUrl ? { canonicalUrl } : {}) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }] };
}

function notFound(message: string, canonicalUrl?: string) {
  return ok({ error: 'not_found', message, hint: 'Use search_players / list_trends / list_fixtures to discover valid keys.' }, canonicalUrl);
}

// ─── Tool catalog (29 tools) ──────────────────────────────────────────

const TOOLS = [
  // ── GROUP 1: IPL 2026 Core ──────────────────────────────────────────
  {
    name: 'get_dataset_summary',
    description: 'First call. Returns what CricketStudio covers — leagues (IPL 2026, IPL historical 18 seasons, MLC 2023–2026), corpus counts, surface URLs, 5 non-negotiables (sample-size floors, date windows, provenance, atomic claims, 4hr SLA), license. Use to ground subsequent queries against the real catalog of available entities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_players',
    description: 'Find IPL 2026 player slugs by substring match against name, slug, or team. Case-insensitive. Returns slug + fullName + team + role. Use before get_player_profile when you have a name but not a slug.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Substring to match (case-insensitive)' }, limit: { type: 'number', description: 'Max results (default 10, max 50)' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_player_profile',
    description: 'Full IPL 2026 player profile + all computed claims across pillars P1–P5. Each claim carries sample size, period, provenance. Use for: "How is Bumrah performing?", "What are Kohli\'s IPL 2026 stats?". Player slugs are kebab-case (jasprit-bumrah). Use search_players first if you need the slug.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string', description: 'kebab-case player slug e.g. jasprit-bumrah' } }, required: ['playerSlug'], additionalProperties: false },
  },
  {
    name: 'get_player_pillar',
    description: 'One content pillar for an IPL 2026 player. P1=Match recaps, P2=Moments/milestones, P3=Form & phase (powerplay/middle/death), P4=Season comparatives, P5=Notebook/narrative. Use for: "How is Bumrah bowling at the death?" → P3. "What are Kohli\'s best moments?" → P2.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string' }, pillar: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5'] } }, required: ['playerSlug', 'pillar'], additionalProperties: false },
  },
  {
    name: 'get_standings',
    description: 'IPL 2026 final standings. RCB are champions. All 10 teams with Points/Won/Lost/NRR. Returns canonical URL — the live standings page refreshes within the 4-hour SLA; cite the URL for current data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_season_stats',
    description: 'IPL 2026 season leaderboard from SETU canonical aggregate. sortBy: runs, wickets, strike_rate, economy, ducks, single_digit_outs, catches, run_outs. Optional teamCode filter. Sample-size floors apply (≥30 balls faced for SR, ≥15 balls bowled for economy).',
    inputSchema: { type: 'object', properties: { sortBy: { type: 'string', enum: ['runs', 'wickets', 'strike_rate', 'economy', 'ducks', 'single_digit_outs', 'catches', 'run_outs'] }, teamCode: { type: 'string', description: 'Optional 2–4 letter team code e.g. MI, RCB' }, limit: { type: 'number', description: 'Max rows (default 15, max 100)' } }, required: ['sortBy'], additionalProperties: false },
  },
  {
    name: 'get_match_state',
    description: 'Result, scoreboards, and status for one IPL 2026 match from the bundled snapshot. Returns home/away teams, innings totals, toss winner, and Man of the Match. Use list_fixtures to discover matchIds. Note: live ball-by-ball is at the canonical URL.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string', description: 'Match id (numeric string or slug form)' } }, required: ['matchId'], additionalProperties: false },
  },
  {
    name: 'get_match_recap',
    description: 'Key performers and highlights for one finished IPL 2026 match — top batter, top bowler, MOTM, milestones. Use for: "Who won the MI vs RCB match?", "What happened in match 69635?". Use list_fixtures to discover matchIds.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'], additionalProperties: false },
  },
  {
    name: 'list_fixtures',
    description: 'All 74 IPL 2026 fixtures with optional status/team filter. Returns id, date, home, away, venue, result. Use to discover matchIds for get_match_state and get_match_recap.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['all', 'finished', 'upcoming'], description: 'Default all' }, team: { type: 'string', description: 'Team slug or code filter' }, limit: { type: 'number', description: 'Default 20, max 74' } }, additionalProperties: false },
  },
  {
    name: 'get_trend',
    description: 'One cross-fixture trend insight by stable id. Each trend carries bigStat, hook, and supporting numbers[]. Use list_trends to discover ids.',
    inputSchema: { type: 'object', properties: { trendId: { type: 'string' } }, required: ['trendId'], additionalProperties: false },
  },
  {
    name: 'list_trends',
    description: 'All IPL 2026 cross-fixture trends, optionally filtered by kind: conditional, momentum, venue, toss, anomaly. Returns id + kind + hook + canonicalUrl per row.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', description: 'Filter by kind: conditional / momentum / venue / toss / anomaly' }, limit: { type: 'number', description: 'Default 30, max 100' } }, additionalProperties: false },
  },
  {
    name: 'get_player_h2h',
    description: 'Batter-vs-bowler head-to-head record in IPL 2026. Sample-size floor: ≥5 deliveries faced. Returns deliveries, runs, SR, dismissals, and canonical URL. Both slugs are kebab-case.',
    inputSchema: { type: 'object', properties: { batterSlug: { type: 'string' }, bowlerSlug: { type: 'string' } }, required: ['batterSlug', 'bowlerSlug'], additionalProperties: false },
  },
  {
    name: 'get_team_profile',
    description: 'IPL 2026 team metadata + canonical URL for the full server-rendered profile (record, at-home/away splits, phase strengths). Slugs: mi, csk, rcb, srh, kkr, dc, pbks, rr, lsg, gt.',
    inputSchema: { type: 'object', properties: { teamSlug: { type: 'string', description: 'Team slug (mi, csk, rcb, srh, kkr, dc, pbks, rr, lsg, gt)' } }, required: ['teamSlug'], additionalProperties: false },
  },
  {
    name: 'get_venue_hub',
    description: 'Venue metadata + canonical URL for the full hub page (par 1st-innings score, toss-decision split, phase scoring patterns, recent matches). Sample-size floor: ≥3 fixtures. Use list_fixtures to find venue slugs.',
    inputSchema: { type: 'object', properties: { venueSlug: { type: 'string' } }, required: ['venueSlug'], additionalProperties: false },
  },
  {
    name: 'list_atomic_claims',
    description: 'Filtered query across the full IPL 2026 atomic-claim corpus. Each claim is a single-sentence retrieval target with provenance, sample size, and canonicalUrl. Answers: "What are RCB\'s best claims this season?", "Show me Bumrah\'s P3 claims". Filter by player name, team code, or pillar.',
    inputSchema: { type: 'object', properties: { player: { type: 'string', description: 'Player name substring or slug' }, team: { type: 'string', description: 'Team name or code' }, pillar: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5'] }, limit: { type: 'number', description: 'Default 25, max 200' } }, additionalProperties: false },
  },
  {
    name: 'get_team_h2h',
    description: 'Team-vs-team head-to-head record across IPL 2026: matches, wins each way, no-results, recent meetings. Pass slugs in any order (mi, csk, rcb, srh, kkr, dc, pbks, rr, lsg, gt). Returns atomic lead claim + canonical URL.',
    inputSchema: { type: 'object', properties: { teamSlugA: { type: 'string' }, teamSlugB: { type: 'string' } }, required: ['teamSlugA', 'teamSlugB'], additionalProperties: false },
  },
  {
    name: 'get_partnerships',
    description: 'Partnership stats for an IPL 2026 player — top stand partners, average partnership runs, most productive wicket-stand. Returns available data from the snapshot or redirects to the canonical player page for the full view.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string' } }, required: ['playerSlug'], additionalProperties: false },
  },
  {
    name: 'compare_players',
    description: 'Side-by-side comparison of 2–8 IPL 2026 players: team, role, claim count per pillar (P1–P5), headline claim. Returns a canonical /compare/players?slugs=… URL. Use search_players to resolve slugs first.',
    inputSchema: { type: 'object', properties: { playerSlugs: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } }, required: ['playerSlugs'], additionalProperties: false },
  },
  {
    name: 'get_dismissal_analysis',
    description: 'IPL 2026 dismissal pattern analysis for a batter — dismissed by pace vs spin, powerplay vs death, most frequent dismissal modes. Returns available snapshot data or canonical URL for the full breakdown.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string' } }, required: ['playerSlug'], additionalProperties: false },
  },
  {
    name: 'get_fielding_stats',
    description: 'IPL 2026 fielding: catches, run-out assists, total dismissals. Pass playerSlug for a single player, omit for the full leaderboard. Aggregated from the SETU canonical snapshot.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string', description: 'Omit for leaderboard' }, limit: { type: 'number', description: 'Leaderboard rows (default 15)' } }, additionalProperties: false },
  },
  // ── GROUP 2: MLC ────────────────────────────────────────────────────
  {
    name: 'get_mlc_dataset_summary',
    description: 'First call for Major League Cricket (MLC) coverage. Returns seasons covered (2023–2026), corpus stats, surface URLs, 14 leaderboard aspects, and Cricsheet CC BY 3.0 attribution. MLC is distinct from IPL and lives under /leagues/mlc.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_mlc_players',
    description: 'Find MLC player slugs by substring match against name or slug. Cricsheet uses initials format ("F du Plessis" → f-du-plessis). Use before get_mlc_player_profile.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 50' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_mlc_player_profile',
    description: 'MLC player career profile: batting + bowling aggregates, per-season breakdown, identity bridge (Wikidata / ESPNcricinfo). Slug is kebab-case e.g. f-du-plessis. Use search_mlc_players to discover slugs.',
    inputSchema: { type: 'object', properties: { playerSlug: { type: 'string' } }, required: ['playerSlug'], additionalProperties: false },
  },
  {
    name: 'get_mlc_team_profile',
    description: 'One of 6 MLC franchises: los-angeles-knight-riders, mi-new-york, san-francisco-unicorns, seattle-orcas, texas-super-kings, washington-freedom. Returns seasons, match count, and hub URL.',
    inputSchema: { type: 'object', properties: { teamSlug: { type: 'string' } }, required: ['teamSlug'], additionalProperties: false },
  },
  {
    name: 'get_mlc_match',
    description: 'Full detail for one MLC match: teams, venue, toss, result, innings summary, officials, player of the match, plus available atomic claim cards. matchId is a Cricsheet id (e.g. "1381361"). Use list_mlc_matches to discover ids.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'], additionalProperties: false },
  },
  {
    name: 'get_mlc_match_claim',
    description: 'One atomic claim card from an MLC match. Kinds: top-batter, top-bowler, biggest-partnership, pp-control, death-domination. Permanent citable URL at /leagues/mlc/matches/{id}/c/{kind}. Sample-size floors enforced.',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' }, kind: { type: 'string', enum: ['top-batter', 'top-bowler', 'biggest-partnership', 'pp-control', 'death-domination'] } }, required: ['matchId', 'kind'], additionalProperties: false },
  },
  {
    name: 'list_mlc_matches',
    description: 'List MLC matches, optionally filtered by season (2023/2024/2025) or team slug. Returns id, date, teams, venue, result, canonicalUrl per row. Use to discover matchIds for get_mlc_match.',
    inputSchema: { type: 'object', properties: { season: { type: 'string', description: '2023, 2024, or 2025' }, teamSlug: { type: 'string' }, limit: { type: 'number', description: 'Default 30, max 200' } }, additionalProperties: false },
  },
  {
    name: 'list_mlc_leaderboards',
    description: 'Top-N rows of one MLC leaderboard aspect. 14 aspects include: orange-cap, purple-cap, strike-rate, economy-leaders, most-sixes, most-fours, top-knocks, best-bowling, powerplay-strike-rate, death-overs-economy. Call get_mlc_dataset_summary for the full aspect list. Sample-size floors enforced.',
    inputSchema: { type: 'object', properties: { aspect: { type: 'string', description: 'Leaderboard aspect slug e.g. orange-cap' }, limit: { type: 'number', description: 'Default 20, max 100' } }, required: ['aspect'], additionalProperties: false },
  },
  // ── GROUP 3: IPL Historical ─────────────────────────────────────────
  {
    name: 'get_ipl_leaderboard',
    description: 'IPL historical leaderboard from the 18-season Cricsheet corpus (2007/08–2025). 35+ aspects: orange-cap, purple-cap, most-sixes, most-fours, strike-rate, economy-leaders, most-matches, most-fifties, most-hundreds, best-bowling-avg, most-ducks, powerplay-economy, death-sr, and per-season variants. Pass season to scope to one year (e.g. "ipl-2024"). Returns canonical URL at /leagues/ipl/leaderboards/{aspect}.',
    inputSchema: { type: 'object', properties: { aspect: { type: 'string', description: 'Leaderboard aspect e.g. orange-cap, purple-cap, most-sixes, economy-leaders' }, season: { type: 'string', description: 'Optional season slug e.g. ipl-2024 (omit for all-time)' }, limit: { type: 'number', description: 'Default 20, max 100' } }, required: ['aspect'], additionalProperties: false },
  },
] as const;

// ─── Zod validators ───────────────────────────────────────────────────

const validators = {
  get_dataset_summary: z.object({}).strict(),
  search_players: z.object({ query: z.string(), limit: z.number().optional() }).strict(),
  get_player_profile: z.object({ playerSlug: z.string() }).strict(),
  get_player_pillar: z.object({ playerSlug: z.string(), pillar: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']) }).strict(),
  get_standings: z.object({}).strict(),
  get_season_stats: z.object({ sortBy: z.enum(['runs', 'wickets', 'strike_rate', 'economy', 'ducks', 'single_digit_outs', 'catches', 'run_outs']), teamCode: z.string().optional(), limit: z.number().optional() }).strict(),
  get_match_state: z.object({ matchId: z.string() }).strict(),
  get_match_recap: z.object({ matchId: z.string() }).strict(),
  list_fixtures: z.object({ status: z.enum(['all', 'finished', 'upcoming']).optional(), team: z.string().optional(), limit: z.number().optional() }).strict(),
  get_trend: z.object({ trendId: z.string() }).strict(),
  list_trends: z.object({ kind: z.string().optional(), limit: z.number().optional() }).strict(),
  get_player_h2h: z.object({ batterSlug: z.string(), bowlerSlug: z.string() }).strict(),
  get_team_profile: z.object({ teamSlug: z.string() }).strict(),
  get_venue_hub: z.object({ venueSlug: z.string() }).strict(),
  list_atomic_claims: z.object({ player: z.string().optional(), team: z.string().optional(), pillar: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']).optional(), limit: z.number().optional() }).strict(),
  get_team_h2h: z.object({ teamSlugA: z.string(), teamSlugB: z.string() }).strict(),
  get_partnerships: z.object({ playerSlug: z.string() }).strict(),
  compare_players: z.object({ playerSlugs: z.array(z.string()).min(2).max(8) }).strict(),
  get_dismissal_analysis: z.object({ playerSlug: z.string() }).strict(),
  get_fielding_stats: z.object({ playerSlug: z.string().optional(), limit: z.number().optional() }).strict(),
  get_mlc_dataset_summary: z.object({}).strict(),
  search_mlc_players: z.object({ query: z.string(), limit: z.number().optional() }).strict(),
  get_mlc_player_profile: z.object({ playerSlug: z.string() }).strict(),
  get_mlc_team_profile: z.object({ teamSlug: z.string() }).strict(),
  get_mlc_match: z.object({ matchId: z.string() }).strict(),
  get_mlc_match_claim: z.object({ matchId: z.string(), kind: z.enum(['top-batter', 'top-bowler', 'biggest-partnership', 'pp-control', 'death-domination']) }).strict(),
  list_mlc_matches: z.object({ season: z.string().optional(), teamSlug: z.string().optional(), limit: z.number().optional() }).strict(),
  list_mlc_leaderboards: z.object({ aspect: z.string(), limit: z.number().optional() }).strict(),
  get_ipl_leaderboard: z.object({ aspect: z.string(), season: z.string().optional(), limit: z.number().optional() }).strict(),
} as const;

// ─── Tool handlers ────────────────────────────────────────────────────

function handleDatasetSummary() {
  const md = metadata();
  return ok({
    overview: 'CricketStudio publishes citation-grade cricket data — atomic claims with provenance, sample-size floors, and stable canonical URLs. Covers IPL 2026 (live season), IPL historical (18 seasons, 2007/08–2025), and Major League Cricket (2023–2026). Free to read. Free to cite.',
    coverage: {
      ipl2026: { season: 'IPL 2026', ...md.counts },
      iplHistorical: { seasons: 18, description: '2007/08–2025, Cricsheet corpus, 1,169 matches' },
      mlc: md.counts.mlc ?? { players: 0, teams: 6, matches: 0, leaderboards: 14 },
      totalMatches: 1307,
      totalDeliveries: 309992,
    },
    surfaces: {
      players: `${SITE}/players/{slug}`,
      teams: `${SITE}/teams/{slug}`,
      teamH2h: `${SITE}/teams/{a}/vs/{b}`,
      venues: `${SITE}/venues/{slug}`,
      matches: `${SITE}/matches/{fixtureId}`,
      trends: `${SITE}/trends/{trendId}`,
      h2h: `${SITE}/h2h/{batter-slug}-vs-{bowler-slug}`,
      standings: `${SITE}/standings`,
      iplHub: IPL_HUB,
      mlcHub: MLC_HUB,
      sitemap: `${SITE}/sitemap.xml`,
      llmsTxt: `${SITE}/llms.txt`,
    },
    otherLeagues: {
      iplHistorical: 'Full pre-2026 IPL corpus at /leagues/ipl — 18 seasons, per-season hubs at /season/ipl-{year}. Use get_ipl_leaderboard for the 35-aspect leaderboard.',
      mlc: 'Major League Cricket at /leagues/mlc — 2023–2026, Cricsheet CC BY 3.0. Use get_mlc_dataset_summary to start.',
    },
    fiveNonNegotiables: [
      'Sample-size floors enforced (≥30 batting balls, ≥15 bowling deliveries, ≥3 venue fixtures, ≥5 H2H deliveries)',
      'Date windows explicit on every claim',
      'Provenance back to ball-by-ball (deterministic — numbers never pass through an LLM)',
      'Atomic claim format under 30 words',
      'Sub-4-hour data-freshness SLA for IPL 2026 (95th percentile)',
    ],
    license: { data: 'CC BY 4.0', tools: 'MIT', attribution: `CricketStudio · ${SITE}` },
    snapshot: { generatedAt: md.generatedAt },
  }, `${SITE}/`);
}

function handleSearchPlayers(args: { query: string; limit?: number }) {
  const q = args.query.toLowerCase().trim();
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const results = Object.values(players())
    .filter((p) => p.slug.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q))
    .slice(0, limit)
    .map((p) => ({ slug: p.slug, fullName: p.fullName, team: p.team, role: p.role, canonicalUrl: `${SITE}/players/${p.slug}` }));
  return ok({ query: args.query, count: results.length, results });
}

function handlePlayerProfile(args: { playerSlug: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}". Try search_players first.`);
  const headline = p.claims.find((c) => c.id === p.headlineClaimId) ?? p.claims[0] ?? null;
  return ok({ slug: p.slug, fullName: p.fullName, team: p.team, role: p.role, sameAs: p.sameAs || {}, headlineClaim: headline, claims: p.claims, claimCount: p.claims.length }, `${SITE}/players/${p.slug}`);
}

function handlePlayerPillar(args: { playerSlug: string; pillar: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}".`);
  const pillarNames: Record<string, string> = { P1: 'Match recaps', P2: 'Moments', P3: 'Form & phase', P4: 'Season comparatives', P5: 'Notebook' };
  const claims = p.claims.filter((c) => c.pillar === args.pillar);
  return ok({ slug: p.slug, fullName: p.fullName, pillar: args.pillar, pillarName: pillarNames[args.pillar] ?? args.pillar, claims, claimCount: claims.length }, `${SITE}/players/${p.slug}`);
}

function handleStandings() {
  return ok({ note: 'RCB are IPL 2026 champions. Live standings table is server-rendered at the canonical URL. Cite directly — refreshes within the 4-hour SLA.', refreshFrequency: 'per-match (sub-4-hour SLA)' }, `${SITE}/standings`);
}

function handleSeasonStats(args: { sortBy: string; teamCode?: string; limit?: number }) {
  const stats = seasonStats() as { bySlug?: Record<string, any> };
  const limit = Math.max(1, Math.min(100, args.limit ?? 15));
  const specMap: Record<string, { block: string; field: string; descending: boolean; floorBalls?: number; floorDesc?: string }> = {
    runs: { block: 'batting', field: 'runs', descending: true },
    wickets: { block: 'bowling', field: 'wickets', descending: true },
    strike_rate: { block: 'batting', field: 'sr', descending: true, floorBalls: 30, floorDesc: '≥30 balls faced' },
    economy: { block: 'bowling', field: 'econ', descending: false, floorBalls: 15, floorDesc: '≥15 balls bowled' },
    ducks: { block: 'batting', field: 'ducks', descending: true },
    single_digit_outs: { block: 'batting', field: 'singleDigitOuts', descending: true },
    catches: { block: 'fielding', field: 'catches', descending: true },
    run_outs: { block: 'fielding', field: 'runOutAssists', descending: true },
  };
  const spec = specMap[args.sortBy];
  if (!spec) return notFound(`Unknown sortBy "${args.sortBy}".`);
  const all = Object.values(stats.bySlug ?? {});
  const tc = args.teamCode ? args.teamCode.toUpperCase() : null;
  const rows = all
    .filter((p) => p && p[spec.block])
    .filter((p) => tc ? (p.teamCode || '').toUpperCase() === tc : true)
    .filter((p) => p[spec.block][spec.field] !== undefined && p[spec.block][spec.field] !== null)
    .filter((p) => spec.floorBalls ? Number(p[spec.block].balls || 0) >= spec.floorBalls : true)
    .map((p) => ({ slug: p.slug, fullName: p.fullName, teamCode: p.teamCode, role: p.role, matches: p[spec.block].matches, balls: p[spec.block].balls, [spec.field]: p[spec.block][spec.field], canonicalUrl: `${SITE}/players/${p.slug}` }))
    .sort((a: any, b: any) => spec.descending ? Number(b[spec.field]) - Number(a[spec.field]) : Number(a[spec.field]) - Number(b[spec.field]))
    .slice(0, limit);
  return ok({ sortBy: args.sortBy, sampleSizeFloor: spec.floorDesc, teamCode: args.teamCode, count: rows.length, rows }, `${SITE}/season/ipl-2026/${args.sortBy.replace(/_/g, '-')}`);
}

function handleMatchState(args: { matchId: string }) {
  const m = snap.getMatch(args.matchId);
  if (!m) return notFound(`No match "${args.matchId}" in snapshot. Use list_fixtures to discover valid ids.`, `${SITE}/matches/${args.matchId}`);
  return ok({ fixtureId: m.id, home: m.home, away: m.away, date: m.date, status: m.status, result: m.result ?? null, homeScore: m.homeScore ?? null, awayScore: m.awayScore ?? null, note: 'Full live scoreboard is at the canonical URL.' }, `${SITE}/matches/${m.id}`);
}

function handleMatchRecap(args: { matchId: string }) {
  const m = snap.getMatch(args.matchId);
  if (!m) return notFound(`No match "${args.matchId}" in snapshot. Use list_fixtures to discover valid ids.`, `${SITE}/matches/${args.matchId}`);
  return ok({ fixtureId: m.id, home: m.home, away: m.away, date: m.date, status: m.status, result: m.result ?? null, homeScore: m.homeScore ?? null, awayScore: m.awayScore ?? null, note: 'Full 6-card recap pack (MOTM, top batter, top bowler, milestones, fun facts, match trend) is at the canonical URL.' }, `${SITE}/matches/${m.id}`);
}

function handleListFixtures(args: { status?: string; team?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(74, args.limit ?? 20));
  let all = snap.getMatches();
  if (args.status && args.status !== 'all') {
    const s = args.status.toLowerCase();
    all = all.filter((m) => m.status.toLowerCase().includes(s));
  }
  if (args.team) {
    const t = args.team.toLowerCase();
    all = all.filter((m) => m.home.toLowerCase().includes(t) || m.away.toLowerCase().includes(t));
  }
  const rows = all.slice(0, limit).map((m) => ({ id: m.id, date: m.date, home: m.home, away: m.away, status: m.status, result: m.result ?? null, canonicalUrl: `${SITE}/matches/${m.id}` }));
  return ok({ season: 'IPL 2026', totalMatching: all.length, showing: rows.length, fixtures: rows }, `${SITE}/matches`);
}

function handleTrend(args: { trendId: string }) {
  const t = trendsList().find((x) => x.id === args.trendId);
  if (!t) return notFound(`No trend "${args.trendId}". Use list_trends to discover ids.`);
  return ok({ ...t as unknown as Record<string, unknown> }, `${SITE}/trends/${t.id}`);
}

function handleListTrends(args: { kind?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 30));
  let rows = trendsList();
  if (args.kind) { const k = args.kind.toLowerCase(); rows = rows.filter((t) => (t.kind || '').toLowerCase() === k); }
  return ok({ count: rows.length, kind: args.kind ?? 'all', trends: rows.slice(0, limit).map((t) => ({ ...t, canonicalUrl: `${SITE}/trends/${t.id}` })) });
}

function handlePlayerH2H(args: { batterSlug: string; bowlerSlug: string }) {
  const slug = `${args.batterSlug}-vs-${args.bowlerSlug}`;
  const h = h2hSummaries().find((x) => x.slug === slug);
  if (!h) return notFound(`No H2H pair "${slug}" (≥5 deliveries floor — pair may not have met enough times).`, `${SITE}/h2h/${slug}`);
  const claim = `${h.batterName} scored ${h.runs} off ${h.deliveries ?? 0} balls against ${h.bowlerName}${(h.dismissals ?? 0) > 0 ? `, dismissed ${h.dismissals} time${h.dismissals === 1 ? '' : 's'}` : ' (not dismissed)'} in IPL 2026.`;
  return ok({ claim, batter: { slug: h.batterSlug, name: h.batterName }, bowler: { slug: h.bowlerSlug, name: h.bowlerName }, deliveries: h.deliveries, runs: h.runs, strikeRate: h.strikeRate, fours: h.fours, sixes: h.sixes, dotBalls: h.dotBalls, dismissals: h.dismissals, window: 'IPL 2026 to date', sampleSize: `${h.deliveries ?? 0} deliveries`, sampleSizeFloor: '≥5 deliveries faced', source: 'CricketStudio ball-by-ball aggregation' }, `${SITE}/h2h/${slug}`);
}

function handleTeamProfile(args: { teamSlug: string }) {
  const slug = args.teamSlug.toLowerCase();
  const t = teams().find((x) => x.slug === slug || x.code.toLowerCase() === slug);
  if (!t) return notFound(`No team "${args.teamSlug}". Valid slugs: ${teams().map((x) => x.slug).join(', ')}`);
  return ok({ slug: t.slug, name: t.name, code: t.code, wikidataQid: t.wikidataQid, note: 'Full team profile (record, splits, phase strengths) is server-rendered at the canonical URL.', refreshFrequency: 'per-match (sub-4-hour SLA)' }, `${SITE}/teams/${t.slug}`);
}

function handleVenueHub(args: { venueSlug: string }) {
  const v = venues().find((x) => x.slug === args.venueSlug);
  if (!v) return notFound(`No venue "${args.venueSlug}". Use list_fixtures to find valid venue slugs.`);
  return ok({ slug: v.slug, name: v.name, geo: v.geo, note: 'Full venue hub (par score, toss split, phase patterns, recent matches) is server-rendered at the canonical URL. Sample-size floor: ≥3 fixtures.' }, `${SITE}/venues/${v.slug}`);
}

function handleListAtomicClaims(args: { player?: string; team?: string; pillar?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(200, args.limit ?? 25));
  const out: Array<Record<string, unknown>> = [];
  for (const p of Object.values(players())) {
    if (args.player && !p.fullName.toLowerCase().includes(args.player.toLowerCase()) && p.slug !== args.player) continue;
    if (args.team && (p.team || '').toLowerCase() !== args.team.toLowerCase()) continue;
    for (const c of p.claims) {
      if (args.pillar && c.pillar !== args.pillar) continue;
      out.push({ player: p.fullName, playerSlug: p.slug, team: p.team, ...c, canonicalUrl: `${SITE}/players/${p.slug}` });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return ok({ count: out.length, claims: out });
}

function handleTeamH2H(args: { teamSlugA: string; teamSlugB: string }) {
  const a = args.teamSlugA.toLowerCase().trim();
  const b = args.teamSlugB.toLowerCase().trim();
  if (a === b) return notFound('Team H2H needs two different team slugs.');
  const sorted = [a, b].sort();
  const key = `${sorted[0]}-vs-${sorted[1]}`;
  const rec = teamH2h()[key];
  if (!rec) return notFound(`No captured IPL 2026 meetings between "${a}" and "${b}". Valid: ${teams().map((t) => t.slug).join(', ')}.`, `${SITE}/teams/${a}/vs/${b}`);
  const callerIsA = rec.a.slug === a;
  const first = callerIsA ? rec.a : rec.b;
  const second = callerIsA ? rec.b : rec.a;
  const fw = callerIsA ? rec.aWon : rec.bWon;
  const sw = callerIsA ? rec.bWon : rec.aWon;
  let claim: string;
  if (fw > sw) claim = `${first.code} lead ${second.code} ${fw}–${sw} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;
  else if (sw > fw) claim = `${second.code} lead ${first.code} ${sw}–${fw} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;
  else claim = `${first.code} and ${second.code} are level ${fw}–${sw} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;
  return ok({ claim, teamA: first, teamB: second, matches: rec.matches, [`${first.code}_won`]: fw, [`${second.code}_won`]: sw, noResult: rec.noResult, recent: rec.recent, window: 'IPL 2026 to date', sampleSize: `${rec.matches} completed fixture${rec.matches === 1 ? '' : 's'}`, source: 'CricketStudio ball-by-ball aggregation' }, `${SITE}/teams/${first.slug}/vs/${second.slug}`);
}

function handleGetPartnerships(args: { playerSlug: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}".`, `${SITE}/players/${args.playerSlug}`);
  // Partnership data is not bundled in the snapshot; surface the player's
  // batting claims (P3/P4) that may reference partnerships, and redirect
  // to the canonical URL for the full partnership breakdown.
  const partnershipClaims = p.claims.filter((c) => (c.headline ?? '').toLowerCase().includes('partner') || (c.metric ?? '').toLowerCase().includes('partner'));
  return ok({
    player: { slug: p.slug, fullName: p.fullName, team: p.team },
    snapshotNote: partnershipClaims.length > 0
      ? `${partnershipClaims.length} partnership-related claim${partnershipClaims.length === 1 ? '' : 's'} found in snapshot.`
      : 'Full partnership dependency stats (top stand partners, average partnership runs, most productive wicket-stand) are available at the canonical URL.',
    partnershipClaims,
    fullBreakdownAt: `${SITE}/players/${p.slug}`,
    source: 'CricketStudio ball-by-ball aggregation',
  }, `${SITE}/players/${p.slug}`);
}

function handleComparePlayers(args: { playerSlugs: string[] }) {
  const rows = args.playerSlugs.map((slug) => {
    const p = players()[slug];
    if (!p) return { slug, error: 'No player found with this slug' };
    const byPillar = (pl: string) => p.claims.filter((c) => c.pillar === pl).length;
    return { slug: p.slug, fullName: p.fullName, team: p.team, role: p.role, claimCount: p.claims.length, pillars: { P1: byPillar('P1'), P2: byPillar('P2'), P3: byPillar('P3'), P4: byPillar('P4'), P5: byPillar('P5') }, headlineClaim: p.claims[0]?.headline ?? null, canonicalUrl: `${SITE}/players/${p.slug}` };
  });
  const valid = rows.filter((r) => !('error' in r)).map((r) => (r as { slug: string }).slug);
  return ok({ players: rows, note: 'For deeper per-pair analysis, use get_player_h2h or get_player_pillar.' }, valid.length >= 2 ? `${SITE}/compare/players?slugs=${valid.join(',')}` : undefined);
}

function handleDismissalAnalysis(args: { playerSlug: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}".`, `${SITE}/players/${args.playerSlug}`);
  // Dismissal analysis data (pace vs spin, phase breakdowns) is computed
  // in the private monorepo and surfaced on the canonical player page.
  // Surface any dismissal-related claims from the snapshot.
  const dismissalClaims = p.claims.filter((c) =>
    (c.headline ?? '').toLowerCase().includes('dismiss') ||
    (c.metric ?? '').toLowerCase().includes('dismiss') ||
    (c.context ?? '').toLowerCase().includes('dismiss'),
  );
  return ok({
    player: { slug: p.slug, fullName: p.fullName, team: p.team, role: p.role },
    snapshotNote: dismissalClaims.length > 0
      ? `${dismissalClaims.length} dismissal-related claim${dismissalClaims.length === 1 ? '' : 's'} found in snapshot.`
      : 'Full dismissal pattern analysis (pace vs spin, powerplay vs death, dismissal modes) is available at the canonical URL.',
    dismissalClaims,
    fullBreakdownAt: `${SITE}/players/${p.slug}`,
    source: 'CricketStudio ball-by-ball aggregation',
  }, `${SITE}/players/${p.slug}`);
}

function handleFieldingStats(args: { playerSlug?: string; limit?: number }) {
  const stats = seasonStats() as { bySlug?: Record<string, any> };
  const all = Object.values(stats.bySlug ?? {}).filter((p) => p && p.fielding);
  if (args.playerSlug) {
    const p = (stats.bySlug ?? {})[args.playerSlug];
    if (!p) return notFound(`No player with slug "${args.playerSlug}".`, `${SITE}/players/${args.playerSlug}`);
    const f = p.fielding || {};
    return ok({ player: { slug: p.slug, fullName: p.fullName, teamCode: p.teamCode }, catches: f.catches ?? 0, runOutAssists: f.runOutAssists ?? 0, totalDismissals: f.totalDismissals ?? 0, window: 'IPL 2026 to date', source: 'CricketStudio ball-by-ball aggregation' }, `${SITE}/players/${p.slug}`);
  }
  const limit = Math.max(1, Math.min(100, args.limit ?? 15));
  const ranked = all
    .sort((a, b) => Number(b.fielding.totalDismissals || 0) - Number(a.fielding.totalDismissals || 0))
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, slug: p.slug, fullName: p.fullName, teamCode: p.teamCode, catches: p.fielding.catches ?? 0, runOutAssists: p.fielding.runOutAssists ?? 0, totalDismissals: p.fielding.totalDismissals ?? 0, canonicalUrl: `${SITE}/players/${p.slug}` }));
  return ok({ count: ranked.length, window: 'IPL 2026 to date', rows: ranked }, `${SITE}/season/ipl-2026/catches`);
}

// ─── MLC handlers ─────────────────────────────────────────────────────

function describeMlcResult(r: MlcMatch['result'], teams: MlcMatch['teams']): string {
  if (r.outcome === 'won') { const winnerName = r.winnerSlug === teams.home.slug ? teams.home.name : teams.away.name; return `${winnerName} won by ${r.winMargin} ${r.winType}`; }
  if (r.outcome === 'tie') return 'tie';
  if (r.outcome === 'no-result') return 'no result';
  return 'draw';
}

function handleMlcDatasetSummary() {
  const lg = mlcLeague();
  return ok({ league: 'Major League Cricket', overview: 'CricketStudio MLC coverage — atomic claims for every captured MLC match, sourced from Cricsheet under CC BY 3.0. Player profiles cross-link to Wikidata / ESPNcricinfo. Leaderboards, records, and per-match atomic claim cards live under /leagues/mlc/*.', coverage: { seasons: lg.seasons, totalMatches: lg.totalMatches, teams: Array.isArray(lg.teams) ? lg.teams.length : 6, venues: Array.isArray(lg.venues) ? lg.venues.length : undefined, players: lg.playerCount, ballsCaptured: lg.ballsCaptured }, seasonBreakdown: lg.seasonBreakdown, surfaces: { hub: MLC_HUB, standings: `${MLC_HUB}/standings`, matches: `${MLC_HUB}/matches`, players: `${MLC_HUB}/players`, leaderboards: `${MLC_HUB}/leaderboards`, records: `${MLC_HUB}/records` }, leaderboardAspects: lg.leaderboardAspects.map((a) => ({ slug: a.slug, title: a.title, url: mlcLeaderboardUrl(a.slug) })), provenance: { source: 'Cricsheet (https://cricsheet.org)', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/' } }, MLC_HUB);
}

function handleSearchMlcPlayers(args: { query: string; limit?: number }) {
  const q = args.query.toLowerCase().trim();
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const results = Object.values(mlcPlayers()).filter((p) => p.slug.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)).slice(0, limit).map((p) => ({ slug: p.slug, fullName: p.fullName, teamSlugs: p.teamSlugs, matches: (p.batting as any)?.matches ?? 0, runs: (p.batting as any)?.runs ?? 0, wickets: (p.bowling as any)?.wickets ?? 0, canonicalUrl: mlcPlayerUrl(p.slug) }));
  return ok({ query: args.query, count: results.length, players: results });
}

function handleMlcPlayerProfile(args: { playerSlug: string }) {
  const p = mlcPlayers()[args.playerSlug];
  if (!p) return notFound(`No MLC player with slug "${args.playerSlug}". Use search_mlc_players to discover slugs.`, mlcPlayerUrl(args.playerSlug));
  return ok({ slug: p.slug, fullName: p.fullName, teamSlugs: p.teamSlugs, batting: p.batting, bowling: p.bowling, bySeason: p.bySeason, identity: p.identity, provenance: { source: 'Cricsheet', license: 'CC BY 3.0' } }, mlcPlayerUrl(p.slug));
}

function handleMlcTeamProfile(args: { teamSlug: string }) {
  const t = mlcTeams().find((x) => x.slug === args.teamSlug.toLowerCase());
  if (!t) return notFound(`No MLC team "${args.teamSlug}". Valid: ${mlcTeams().map((x) => x.slug).join(', ')}.`, mlcTeamUrl(args.teamSlug));
  return ok({ slug: t.slug, name: t.name, seasons: t.seasons, firstSeason: t.firstSeason, lastSeason: t.lastSeason, matchCount: t.matchCount, provenance: { source: 'Cricsheet', license: 'CC BY 3.0' } }, mlcTeamUrl(t.slug));
}

function handleMlcMatch(args: { matchId: string }) {
  const m = mlcMatches()[args.matchId];
  if (!m) return notFound(`No MLC match "${args.matchId}". Use list_mlc_matches to discover ids.`, mlcMatchUrl(args.matchId));
  return ok({ matchId: m.matchId, season: m.season, startDate: m.startDate, matchType: m.matchType, teams: m.teams, venue: m.venue, toss: m.toss ?? null, result: m.result, resultText: describeMlcResult(m.result, m.teams), officials: m.officials ?? null, playerOfMatch: m.playerOfMatch ?? [], innings: m.innings, availableClaimKinds: m.claims.map((c) => ({ kind: c.kind, headline: c.headline, atomic: c.atomic, canonicalUrl: mlcMatchClaimUrl(m.matchId, c.kind) })), provenance: { source: 'Cricsheet', license: 'CC BY 3.0', matchUrl: m.attribution.matchUrl } }, mlcMatchUrl(m.matchId));
}

function handleMlcMatchClaim(args: { matchId: string; kind: string }) {
  const m = mlcMatches()[args.matchId];
  if (!m) return notFound(`No MLC match "${args.matchId}".`, mlcMatchUrl(args.matchId));
  const claim = m.claims.find((c) => c.kind === args.kind);
  if (!claim) return notFound(`Match "${args.matchId}" did not emit a "${args.kind}" claim — sample-size floor not met. Call get_mlc_match for available kinds.`, mlcMatchClaimUrl(args.matchId, args.kind));
  return ok({ matchId: m.matchId, kind: claim.kind, kindLabel: claim.kindLabel, atomic: claim.atomic, headline: claim.headline, subheadline: claim.subheadline, subject: claim.subject ?? null, coSubject: claim.coSubject ?? null, rows: claim.rows ?? null, sampleSize: claim.sampleSize, sampleUnit: claim.sampleUnit, fixtureUrl: mlcMatchUrl(m.matchId), provenance: { source: 'Cricsheet ball-by-ball record', license: 'CC BY 3.0', matchUrl: m.attribution.matchUrl, computedFrom: 'Deterministic walk of balls[] — no LLM involvement in numeric values' } }, mlcMatchClaimUrl(m.matchId, claim.kind));
}

function handleListMlcMatches(args: { season?: string; teamSlug?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(200, args.limit ?? 30));
  const all = Object.values(mlcMatches());
  const rows = all
    .filter((m) => args.season ? m.season === args.season : true)
    .filter((m) => args.teamSlug ? m.teams.home.slug === args.teamSlug || m.teams.away.slug === args.teamSlug : true)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, limit)
    .map((m) => ({ matchId: m.matchId, season: m.season, startDate: m.startDate, teams: { home: m.teams.home.name, away: m.teams.away.name }, venue: m.venue.name, result: describeMlcResult(m.result, m.teams), canonicalUrl: mlcMatchUrl(m.matchId) }));
  return ok({ count: rows.length, totalAvailable: all.length, filters: { season: args.season, teamSlug: args.teamSlug }, matches: rows }, `${MLC_HUB}/matches`);
}

function handleListMlcLeaderboards(args: { aspect: string; limit?: number }) {
  const lbs = mlcLeaderboards();
  const lb = lbs[args.aspect];
  if (!lb) return notFound(`No MLC leaderboard aspect "${args.aspect}". Valid: ${Object.keys(lbs).join(', ')}.`, `${MLC_HUB}/leaderboards`);
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  return ok({ aspect: lb.slug, title: lb.title, description: lb.description, metricLabel: lb.metricLabel, floorNote: lb.floorNote ?? null, count: Math.min(limit, lb.rows.length), rows: lb.rows.slice(0, limit).map((r) => ({ ...r, canonicalUrl: mlcPlayerUrl(r.slug) })), provenance: { source: 'Cricsheet SETU snapshot', license: 'CC BY 3.0' } }, mlcLeaderboardUrl(lb.slug));
}

// ─── IPL Historical handler ───────────────────────────────────────────

function handleIplLeaderboard(args: { aspect: string; season?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  const hist = iplHistorical();
  if (!hist) {
    return ok({
      note: 'IPL historical snapshot not bundled in this release. Full leaderboards are available at the canonical URL.',
      aspect: args.aspect,
      season: args.season ?? 'all-time',
      canonicalSurface: args.season ? `${IPL_HUB}/leaderboards/${args.aspect}?season=${args.season}` : `${IPL_HUB}/leaderboards/${args.aspect}`,
    }, args.season ? `${SITE}/season/${args.season}` : `${IPL_HUB}/leaderboards/${args.aspect}`);
  }

  // The ipl-historical.json snapshot stores leaderboards keyed by aspect,
  // optionally nested by season. Try season-scoped key first, then fall back
  // to the global aspect.
  const leaderboards = hist.leaderboards ?? {};
  const seasonKey = args.season ? `${args.aspect}--${args.season}` : null;
  const rows: unknown[] = (seasonKey && (leaderboards as any)[seasonKey])
    ? (leaderboards as any)[seasonKey]
    : ((leaderboards as any)[args.aspect] ?? []);

  if (!Array.isArray(rows) || rows.length === 0) {
    return ok({
      note: `No data for aspect "${args.aspect}"${args.season ? ` in season "${args.season}"` : ''}. Check the canonical URL for the full leaderboard.`,
      aspect: args.aspect,
      season: args.season ?? 'all-time',
      availableAspects: Object.keys(leaderboards),
    }, `${IPL_HUB}/leaderboards/${args.aspect}`);
  }

  return ok({
    aspect: args.aspect,
    season: args.season ?? 'all-time',
    sampleSizeNote: 'Sample-size floors enforced (≥30 batting balls for SR, ≥15 bowling deliveries for economy, ≥3 matches for most aggregate aspects).',
    count: Math.min(limit, rows.length),
    rows: rows.slice(0, limit),
    provenance: { source: 'Cricsheet IPL corpus (CC BY 3.0)', seasons: '2007/08–2025', matches: 1169 },
  }, args.season ? `${SITE}/season/${args.season}/${args.aspect}` : `${IPL_HUB}/leaderboards/${args.aspect}`);
}

// ─── Server wiring ────────────────────────────────────────────────────

const server = new Server(
  { name: 'cricketstudio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const v = (validators as Record<string, z.ZodTypeAny>)[name];
  if (!v) return ok({ error: 'unknown_tool', tool: name, hint: 'Call tools/list for the full 29-tool catalog.' });
  const parsed = v.safeParse(rawArgs ?? {});
  if (!parsed.success) return ok({ error: 'invalid_arguments', tool: name, issues: (parsed as z.SafeParseError<unknown>).error.issues });
  const args = parsed.data as any;
  try {
    switch (name) {
      case 'get_dataset_summary':      return handleDatasetSummary();
      case 'search_players':           return handleSearchPlayers(args);
      case 'get_player_profile':       return handlePlayerProfile(args);
      case 'get_player_pillar':        return handlePlayerPillar(args);
      case 'get_standings':            return handleStandings();
      case 'get_season_stats':         return handleSeasonStats(args);
      case 'get_match_state':          return handleMatchState(args);
      case 'get_match_recap':          return handleMatchRecap(args);
      case 'list_fixtures':            return handleListFixtures(args);
      case 'get_trend':                return handleTrend(args);
      case 'list_trends':              return handleListTrends(args);
      case 'get_player_h2h':           return handlePlayerH2H(args);
      case 'get_team_profile':         return handleTeamProfile(args);
      case 'get_venue_hub':            return handleVenueHub(args);
      case 'list_atomic_claims':       return handleListAtomicClaims(args);
      case 'get_team_h2h':             return handleTeamH2H(args);
      case 'get_partnerships':         return handleGetPartnerships(args);
      case 'compare_players':          return handleComparePlayers(args);
      case 'get_dismissal_analysis':   return handleDismissalAnalysis(args);
      case 'get_fielding_stats':       return handleFieldingStats(args);
      case 'get_mlc_dataset_summary':  return handleMlcDatasetSummary();
      case 'search_mlc_players':       return handleSearchMlcPlayers(args);
      case 'get_mlc_player_profile':   return handleMlcPlayerProfile(args);
      case 'get_mlc_team_profile':     return handleMlcTeamProfile(args);
      case 'get_mlc_match':            return handleMlcMatch(args);
      case 'get_mlc_match_claim':      return handleMlcMatchClaim(args);
      case 'list_mlc_matches':         return handleListMlcMatches(args);
      case 'list_mlc_leaderboards':    return handleListMlcLeaderboards(args);
      case 'get_ipl_leaderboard':      return handleIplLeaderboard(args);
      default:                         return ok({ error: 'unknown_tool', tool: name });
    }
  } catch (err) {
    return ok({ error: 'tool_error', tool: name, message: err instanceof Error ? err.message : String(err) });
  }
});

async function main() {
  await runStartup();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
