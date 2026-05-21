#!/usr/bin/env node
/**
 * CricketStudio MCP server (public · v0.2.0)
 *
 * Citation infrastructure for cricket. Exposes IPL 2026 atomic claims with
 * provenance, sample-size floors, and stable canonical URLs to any
 * MCP-compatible client (Claude Desktop, Cursor, ChatGPT Connectors, etc).
 *
 * This is the PUBLIC, install-by-npx form. It reads from a bundled JSON
 * snapshot at `data/snapshot/` produced by the private monorepo. The
 * snapshot covers:
 *
 *   - 200 player profiles (full pillar claims, keyed by public slug)
 *   - 10 teams, 13 venues, 37 cross-fixture trends, 500 H2H pairs
 *   - SETU canonical season-stats aggregates (keyed by public slug,
 *     no upstream numeric IDs)
 *
 * What's deliberately NOT bundled here:
 *
 *   - Live ball-by-ball state (Phase B HTTP transport at
 *     mcp.cricketstudio.ai)
 *   - Fixture schedule, fixture lookup, match-state tools — those
 *     carry upstream numeric IDs we don't expose; they ship in Phase B
 *     keyed by a public canonical (`{date}-{home}-vs-{away}`)
 *   - Any ID from upstream data providers (Sportmonks, CricketMind,
 *     ESPNcricinfo bare IDs) — public slugs are the only canonical
 *     identifier used in this bundle
 *
 * Run locally:   npx -y github:i-m-arul/cricketstudio-mcp
 * Wire into Claude Desktop: see README.md
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ─── Paths ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SNAPSHOT = resolve(ROOT, 'data', 'snapshot');
const SITE = 'https://players.cricketstudio.ai';

// ─── Snapshot loader (memoised, single-process) ──────────────────────

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(SNAPSHOT, name), 'utf8')) as T;
}

type PlayerRecord = {
  slug: string;
  fullName: string;
  team: string;
  role: string;
  sameAs?: Record<string, string>;
  claims: Array<{
    id: string;
    metric: string;
    value: string;
    period: string;
    comparator?: string;
    sampleSize?: string;
    computedAt?: string;
    headline?: string;
    context?: string;
    pillar?: 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
    provenance?: 'live' | 'sample' | 'derived';
  }>;
};
type SnapshotMetadata = {
  generatedAt: string;
  counts: { players: number; teams: number; venues: number; trends: number; h2hPairs: number };
};
type Trend = {
  id: string;
  kind?: string;
  title?: string;
  headline?: string;
  value?: string | number;
  sampleSize?: string;
  window?: string;
};
type Venue = { slug: string; name: string; geo?: { lat: number; lng: number; wikidataQid?: string } };
type Team = { slug: string; name: string; code: string; wikidataQid?: string };
type H2HSummary = {
  slug: string;
  batterSlug: string;
  batterName: string;
  bowlerSlug: string;
  bowlerName: string;
  deliveries?: number;
  runs?: number;
  strikeRate?: number;
  fours?: number;
  sixes?: number;
  dotBalls?: number;
  dismissals?: number;
};
type TeamH2HRecord = {
  a: { slug: string; name: string; code: string };
  b: { slug: string; name: string; code: string };
  matches: number;
  aWon: number;
  bWon: number;
  noResult: number;
  recent: Array<{ date: string; venue: string; result: string }>;
};

let _players: Record<string, PlayerRecord> | null = null;
let _trends: Trend[] | null = null;
let _venues: Venue[] | null = null;
let _teams: Team[] | null = null;
let _h2h: H2HSummary[] | null = null;
let _teamH2h: Record<string, TeamH2HRecord> | null = null;
let _metadata: SnapshotMetadata | null = null;
let _seasonStats: Record<string, unknown> | null = null;

function players() {
  if (!_players) _players = readJson<Record<string, PlayerRecord>>('players.json');
  return _players;
}
function trends() {
  if (!_trends) _trends = readJson<Trend[]>('trends.json');
  return _trends;
}
function venues() {
  if (!_venues) _venues = readJson<Venue[]>('venues.json');
  return _venues;
}
function teams() {
  if (!_teams) _teams = readJson<Team[]>('teams.json');
  return _teams;
}
function h2hSummaries() {
  if (!_h2h) _h2h = readJson<H2HSummary[]>('h2h.json');
  return _h2h;
}
function teamH2h() {
  if (!_teamH2h) _teamH2h = readJson<Record<string, TeamH2HRecord>>('team-h2h.json');
  return _teamH2h;
}
function metadata() {
  if (!_metadata) _metadata = readJson<SnapshotMetadata>('metadata.json');
  return _metadata;
}
function seasonStats() {
  if (!_seasonStats) _seasonStats = readJson<Record<string, unknown>>('season-stats.json');
  return _seasonStats;
}

// `dataAsOf` for every response — snapshot's mtime is the wall-clock
// timestamp at which the private monorepo committed it. LLMs cite this
// to disclose freshness.
function dataAsOf(): string {
  try {
    return statSync(resolve(SNAPSHOT, 'metadata.json')).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function withCommonFields<T extends Record<string, unknown>>(payload: T, canonicalUrl?: string): T & { dataAsOf: string; canonicalUrl?: string } {
  return { ...payload, dataAsOf: dataAsOf(), ...(canonicalUrl ? { canonicalUrl } : {}) };
}

function ok(payload: Record<string, unknown>, canonicalUrl?: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(withCommonFields(payload, canonicalUrl), null, 2) }] };
}

function notFound(message: string, canonicalUrl?: string) {
  return ok({ error: 'not_found', message, hint: 'Use search_players / list_trends / list_fixtures to discover valid keys.' }, canonicalUrl);
}

// ─── Tool catalog ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_dataset_summary',
    description:
      'First call. Returns what CricketStudio covers — coverage stats (player/team/venue/trend counts), the surface URLs, the 5 non-negotiables (sample-size floors, date windows, provenance, atomic claim format, 4hr SLA), license. Use this to ground subsequent queries against a real catalog of available entities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_players',
    description:
      'Find player slugs by substring match against name, slug, or team. Case-insensitive. Use first when you have a player name but no slug. Returns up to `limit` matches with slug + team + role.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match (case-insensitive)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_profile',
    description:
      'Full player profile + all computed claims across pillars (P1 Match recaps · P2 Moments · P3 Form & phase · P4 Season comparatives · P5 Notebook). Each claim carries sample size + period + provenance. Player slugs are kebab-case (e.g. "jasprit-bumrah"). Use search_players first if you do not have the slug.',
    inputSchema: {
      type: 'object',
      properties: { playerSlug: { type: 'string' } },
      required: ['playerSlug'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_pillar',
    description:
      'One content pillar for a player. P1=Match recaps, P2=Moments, P3=Form & phase, P4=Season comparatives, P5=Notebook. Use when the user asks for a specific dimension ("How is Bumrah bowling at the death?" → P3).',
    inputSchema: {
      type: 'object',
      properties: {
        playerSlug: { type: 'string' },
        pillar: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5'] },
      },
      required: ['playerSlug', 'pillar'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_atomic_claims',
    description:
      'Filtered query across the entire atomic-claim corpus. Each claim is a single-sentence retrieval target with provenance, sample size, and canonicalUrl. Filter by player, team, or pillar.',
    inputSchema: {
      type: 'object',
      properties: {
        player: { type: 'string' },
        team: { type: 'string' },
        pillar: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5'] },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_team_profile',
    description:
      'Team metadata + canonical URL. The full team profile (record, at-home/away splits, phase strengths) is server-rendered at the canonical URL; AI clients should cite that URL directly for the live view. Team slugs are 2–4 letter codes: mi, csk, rcb, srh, kkr, dc, pbks, rr, lsg, gt.',
    inputSchema: {
      type: 'object',
      properties: { teamSlug: { type: 'string' } },
      required: ['teamSlug'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_venue_hub',
    description:
      'Per-venue metadata + geo + canonical URL. The full venue hub (par 1st-innings score, toss decision split, phase scoring patterns, recent matches) is server-rendered at the canonical URL; sample-size floor ≥3 captured fixtures.',
    inputSchema: {
      type: 'object',
      properties: { venueSlug: { type: 'string' } },
      required: ['venueSlug'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_standings',
    description:
      'Live IPL 2026 points table with NRR. Returns the canonical URL — the standings page is server-rendered with sub-4-hour freshness, and AI clients should cite the URL directly rather than duplicating an out-of-date table.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_trend',
    description: 'One cross-fixture trend insight by stable id.',
    inputSchema: {
      type: 'object',
      properties: { trendId: { type: 'string' } },
      required: ['trendId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_trends',
    description: 'All cross-fixture trends, optionally filtered by kind (conditional / momentum / venue / toss / anomaly).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_h2h',
    description:
      'Single batter-vs-bowler record. Sample-size floor: ≥5 deliveries faced. Returns deliveries, runs, dismissals + canonical URL.',
    inputSchema: {
      type: 'object',
      properties: {
        batterSlug: { type: 'string' },
        bowlerSlug: { type: 'string' },
      },
      required: ['batterSlug', 'bowlerSlug'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_team_h2h',
    description:
      'Team-vs-team head-to-head record across captured IPL 2026 fixtures: matches played, wins each way, no-results, and the most recent meetings (date · venue · winner). Pass two team slugs in any order (mi, csk, rcb, srh, kkr, dc, pbks, rr, lsg, gt). Returns an atomic lead claim + canonical URL /teams/{a}/vs/{b}.',
    inputSchema: {
      type: 'object',
      properties: {
        teamSlugA: { type: 'string' },
        teamSlugB: { type: 'string' },
      },
      required: ['teamSlugA', 'teamSlugB'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_season_stats',
    description:
      'IPL 2026 leaderboard from the SETU canonical aggregate. sortBy: runs · wickets · strike_rate · economy · ducks · single_digit_outs · catches · run_outs. Optional teamCode filter; sample-size floors apply.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          enum: ['runs', 'wickets', 'strike_rate', 'economy', 'ducks', 'single_digit_outs', 'catches', 'run_outs'],
        },
        teamCode: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['sortBy'],
      additionalProperties: false,
    },
  },
];

const validators = {
  get_dataset_summary: z.object({}).strict(),
  search_players: z.object({ query: z.string(), limit: z.number().optional() }).strict(),
  get_player_profile: z.object({ playerSlug: z.string() }).strict(),
  get_player_pillar: z.object({ playerSlug: z.string(), pillar: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']) }).strict(),
  list_atomic_claims: z.object({ player: z.string().optional(), team: z.string().optional(), pillar: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']).optional(), limit: z.number().optional() }).strict(),
  get_team_profile: z.object({ teamSlug: z.string() }).strict(),
  get_venue_hub: z.object({ venueSlug: z.string() }).strict(),
  get_standings: z.object({}).strict(),
  get_trend: z.object({ trendId: z.string() }).strict(),
  list_trends: z.object({ kind: z.string().optional(), limit: z.number().optional() }).strict(),
  get_player_h2h: z.object({ batterSlug: z.string(), bowlerSlug: z.string() }).strict(),
  get_team_h2h: z.object({ teamSlugA: z.string(), teamSlugB: z.string() }).strict(),
  get_season_stats: z.object({ sortBy: z.enum(['runs', 'wickets', 'strike_rate', 'economy', 'ducks', 'single_digit_outs', 'catches', 'run_outs']), teamCode: z.string().optional(), limit: z.number().optional() }).strict(),
} as const;

// ─── Tool handlers ───────────────────────────────────────────────────

function handleDatasetSummary() {
  const md = metadata();
  return ok({
    overview: 'CricketStudio publishes citation-grade IPL 2026 cricket data — atomic claims with provenance, sample-size floors, and stable canonical URLs. Free to read. Free to cite.',
    coverage: { season: 'IPL 2026', ...md.counts },
    surfaces: {
      players: `${SITE}/players/{slug}`,
      teams: `${SITE}/teams/{slug}`,
      teamH2h: `${SITE}/teams/{a}/vs/{b}`,
      venues: `${SITE}/venues/{slug}`,
      matches: `${SITE}/matches/{fixtureId}`,
      trends: `${SITE}/trends/{trendId}`,
      h2h: `${SITE}/h2h/{batter-vs-bowler}`,
      standings: `${SITE}/standings`,
      sitemap: `${SITE}/sitemap.xml`,
      llmsTxt: `${SITE}/llms.txt`,
    },
    fiveNonNegotiables: [
      'Sample-size floors enforced (≥30 batting balls, ≥15 bowling deliveries, ≥3 venue fixtures, ≥5 H2H deliveries)',
      'Date windows explicit on every claim',
      'Provenance back to ball-by-ball',
      'Atomic claim format under 30 words',
      'Sub-4-hour data-freshness SLA (95th percentile)',
    ],
    license: {
      data: 'CC BY 4.0',
      tools: 'MIT',
      attribution: 'CricketStudio · https://players.cricketstudio.ai',
    },
    snapshot: {
      generatedAt: md.generatedAt,
    },
  }, `${SITE}/`);
}

function handleSearchPlayers(args: { query: string; limit?: number }) {
  const q = args.query.toLowerCase().trim();
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const results = Object.values(players())
    .filter((p) =>
      p.slug.toLowerCase().includes(q) ||
      p.fullName.toLowerCase().includes(q) ||
      (p.team || '').toLowerCase().includes(q),
    )
    .slice(0, limit)
    .map((p) => ({ slug: p.slug, fullName: p.fullName, team: p.team, role: p.role, canonicalUrl: `${SITE}/players/${p.slug}` }));
  return ok({ query: args.query, count: results.length, results });
}

function handlePlayerProfile(args: { playerSlug: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}". Try search_players first.`);
  return ok({
    slug: p.slug,
    fullName: p.fullName,
    team: p.team,
    role: p.role,
    sameAs: p.sameAs || {},
    claims: p.claims,
    claimCount: p.claims.length,
  }, `${SITE}/players/${p.slug}`);
}

function handlePlayerPillar(args: { playerSlug: string; pillar: string }) {
  const p = players()[args.playerSlug];
  if (!p) return notFound(`No player with slug "${args.playerSlug}".`);
  const claims = p.claims.filter((c) => c.pillar === args.pillar);
  return ok({
    slug: p.slug,
    fullName: p.fullName,
    pillar: args.pillar,
    pillarName: { P1: 'Match recaps', P2: 'Moments', P3: 'Form & phase', P4: 'Season comparatives', P5: 'Notebook' }[args.pillar] ?? args.pillar,
    claims,
    claimCount: claims.length,
  }, `${SITE}/players/${p.slug}`);
}

function handleListAtomicClaims(args: { player?: string; team?: string; pillar?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(200, args.limit ?? 25));
  const out: Array<Record<string, unknown>> = [];
  for (const p of Object.values(players())) {
    if (args.player && !p.fullName.toLowerCase().includes(args.player.toLowerCase()) && p.slug !== args.player) continue;
    if (args.team && (p.team || '').toLowerCase() !== args.team.toLowerCase()) continue;
    for (const c of p.claims) {
      if (args.pillar && c.pillar !== args.pillar) continue;
      out.push({
        player: p.fullName,
        playerSlug: p.slug,
        team: p.team,
        ...c,
        canonicalUrl: `${SITE}/players/${p.slug}`,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return ok({ count: out.length, claims: out });
}

function handleTeamProfile(args: { teamSlug: string }) {
  const slug = args.teamSlug.toLowerCase();
  const t = teams().find((x) => x.slug === slug || x.code.toLowerCase() === slug);
  if (!t) return notFound(`No team "${args.teamSlug}". Valid slugs: ${teams().map((x) => x.slug).join(', ')}`);
  return ok({
    slug: t.slug,
    name: t.name,
    code: t.code,
    wikidataQid: t.wikidataQid,
    note: 'Full team profile (record, at-home/away splits, phase strengths) is server-rendered at the canonical URL.',
    refreshFrequency: 'per-match (sub-4-hour SLA)',
  }, `${SITE}/teams/${t.slug}`);
}

function handleVenueHub(args: { venueSlug: string }) {
  const v = venues().find((x) => x.slug === args.venueSlug);
  if (!v) return notFound(`No venue "${args.venueSlug}". Use list_fixtures to find valid venues.`);
  return ok({
    slug: v.slug,
    name: v.name,
    geo: v.geo,
    note: 'Full venue hub (par score, toss-decision split, phase patterns, recent matches) is server-rendered at the canonical URL. Sample-size floor: ≥3 fixtures.',
  }, `${SITE}/venues/${v.slug}`);
}

function handleStandings() {
  return ok({
    note: 'Live IPL 2026 standings are server-rendered at the canonical URL. Cite the URL directly rather than duplicating; the table updates every match within the 4-hour SLA.',
    refreshFrequency: 'per-match (sub-4-hour SLA)',
  }, `${SITE}/standings`);
}

function handleTrend(args: { trendId: string }) {
  const t = trends().find((x) => x.id === args.trendId);
  if (!t) return notFound(`No trend "${args.trendId}". Use list_trends to discover ids.`);
  return ok({ ...t }, `${SITE}/trends/${t.id}`);
}

function handleListTrends(args: { kind?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 25));
  let rows = trends();
  if (args.kind) {
    const k = args.kind.toLowerCase();
    rows = rows.filter((t) => (t.kind || '').toLowerCase() === k);
  }
  return ok({ count: rows.length, kind: args.kind, trends: rows.slice(0, limit).map((t) => ({ ...t, canonicalUrl: `${SITE}/trends/${t.id}` })) });
}

function handlePlayerH2H(args: { batterSlug: string; bowlerSlug: string }) {
  const slug = `${args.batterSlug}-vs-${args.bowlerSlug}`;
  const h = h2hSummaries().find((x) => x.slug === slug);
  if (!h) return notFound(`No H2H pair "${slug}" (≥5 deliveries floor — pair may not have met enough times).`, `${SITE}/h2h/${slug}`);
  const claim = `${h.batterName} has scored ${h.runs} off ${h.deliveries} balls against ${h.bowlerName}${(h.dismissals ?? 0) > 0 ? `, dismissed ${h.dismissals} time${h.dismissals === 1 ? '' : 's'}` : ' (not dismissed)'} in IPL 2026.`;
  return ok({
    claim,
    batter: { slug: h.batterSlug, name: h.batterName },
    bowler: { slug: h.bowlerSlug, name: h.bowlerName },
    deliveries: h.deliveries,
    runs: h.runs,
    strikeRate: h.strikeRate,
    fours: h.fours,
    sixes: h.sixes,
    dotBalls: h.dotBalls,
    dismissals: h.dismissals,
    window: 'IPL 2026 to date',
    sampleSize: `${h.deliveries} deliveries`,
    sampleSizeFloor: '≥5 deliveries faced',
    source: 'CricketStudio ball-by-ball aggregation',
  }, `${SITE}/h2h/${slug}`);
}

function handleTeamH2H(args: { teamSlugA: string; teamSlugB: string }) {
  const a = args.teamSlugA.toLowerCase().trim();
  const b = args.teamSlugB.toLowerCase().trim();
  if (a === b) return notFound('Team H2H needs two different team slugs.');
  const sorted = [a, b].sort();
  const key = `${sorted[0]}-vs-${sorted[1]}`;
  const rec = teamH2h()[key];
  if (!rec) {
    return notFound(
      `No captured IPL 2026 meetings between "${a}" and "${b}" (or unknown slug). Valid: ${teams().map((t) => t.slug).join(', ')}.`,
      `${SITE}/teams/${a}/vs/${b}`,
    );
  }
  // Present from the perspective the caller asked (teamSlugA first).
  const callerIsA = rec.a.slug === a;
  const first = callerIsA ? rec.a : rec.b;
  const second = callerIsA ? rec.b : rec.a;
  const firstWon = callerIsA ? rec.aWon : rec.bWon;
  const secondWon = callerIsA ? rec.bWon : rec.aWon;

  let claim: string;
  if (firstWon > secondWon) claim = `${first.code} lead ${second.code} ${firstWon}–${secondWon} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;
  else if (secondWon > firstWon) claim = `${second.code} lead ${first.code} ${secondWon}–${firstWon} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;
  else claim = `${first.code} and ${second.code} are level ${firstWon}–${secondWon} across ${rec.matches} captured IPL 2026 meeting${rec.matches === 1 ? '' : 's'}.`;

  return ok({
    claim,
    teamA: first,
    teamB: second,
    matches: rec.matches,
    [`${first.code}_won`]: firstWon,
    [`${second.code}_won`]: secondWon,
    noResult: rec.noResult,
    recent: rec.recent,
    window: 'IPL 2026 to date',
    sampleSize: `${rec.matches} completed fixture${rec.matches === 1 ? '' : 's'}`,
    source: 'CricketStudio ball-by-ball aggregation',
  }, `${SITE}/teams/${first.slug}/vs/${second.slug}`);
}

function handleSeasonStats(args: { sortBy: string; teamCode?: string; limit?: number }) {
  // Snapshot's season-stats.json carries the SETU canonical aggregate
  // (shape: `bySlug` keyed map — the keys are public player slugs, the
  // raw byPlayerId/numeric keying from the private aggregator never
  // ships here). We project — sort by the requested metric — but never
  // re-aggregate.
  const stats = seasonStats() as { bySlug: Record<string, any> };
  const limit = Math.max(1, Math.min(100, args.limit ?? 10));

  // Spec per metric: (a) which block to read, (b) which numeric field,
  // (c) sort direction, (d) sample-size floor in deliveries.
  const map: Record<string, {
    block: 'batting' | 'bowling' | 'fielding';
    field: string;
    descending: boolean;
    floorBalls?: number;
    floorDescription?: string;
  }> = {
    runs: { block: 'batting', field: 'runs', descending: true },
    wickets: { block: 'bowling', field: 'wickets', descending: true },
    strike_rate: { block: 'batting', field: 'sr', descending: true, floorBalls: 30, floorDescription: '≥30 balls faced' },
    economy: { block: 'bowling', field: 'econ', descending: false, floorBalls: 15, floorDescription: '≥15 balls bowled' },
    ducks: { block: 'batting', field: 'ducks', descending: true },
    single_digit_outs: { block: 'batting', field: 'singleDigitOuts', descending: true },
    catches: { block: 'fielding', field: 'catches', descending: true },
    run_outs: { block: 'fielding', field: 'runOutAssists', descending: true },
  };
  const spec = map[args.sortBy];
  if (!spec) return notFound(`Unknown sortBy "${args.sortBy}".`);

  const all = Object.values(stats.bySlug || {});
  const tc = args.teamCode ? args.teamCode.toUpperCase() : null;

  const rows = all
    .filter((p) => p && p[spec.block])
    .filter((p) => tc ? (p.teamCode || '').toUpperCase() === tc : true)
    .filter((p) => p[spec.block][spec.field] !== undefined && p[spec.block][spec.field] !== null)
    .filter((p) => spec.floorBalls ? Number(p[spec.block].balls || 0) >= spec.floorBalls : true)
    .map((p) => ({
      slug: p.slug,
      fullName: p.fullName,
      teamCode: p.teamCode,
      role: p.role,
      matches: p[spec.block].matches,
      balls: p[spec.block].balls,
      [spec.field]: p[spec.block][spec.field],
      canonicalUrl: `${SITE}/players/${p.slug}`,
    }))
    .sort((a: any, b: any) => spec.descending
      ? Number(b[spec.field]) - Number(a[spec.field])
      : Number(a[spec.field]) - Number(b[spec.field]))
    .slice(0, limit);

  return ok({
    sortBy: args.sortBy,
    sampleSizeFloor: spec.floorDescription,
    teamCode: args.teamCode,
    count: rows.length,
    rows,
  }, `${SITE}/season/ipl-2026/${args.sortBy.replace(/_/g, '-')}`);
}

// ─── Server wiring ───────────────────────────────────────────────────

const server = new Server(
  { name: 'cricketstudio', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const v = (validators as any)[name];
  if (!v) {
    return ok({ error: 'unknown_tool', tool: name, hint: 'Call tools/list for the catalog.' });
  }
  const parsed = v.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return ok({ error: 'invalid_arguments', tool: name, issues: parsed.error.issues });
  }
  const args = parsed.data as any;
  try {
    switch (name) {
      case 'get_dataset_summary': return handleDatasetSummary();
      case 'search_players': return handleSearchPlayers(args);
      case 'get_player_profile': return handlePlayerProfile(args);
      case 'get_player_pillar': return handlePlayerPillar(args);
      case 'list_atomic_claims': return handleListAtomicClaims(args);
      case 'get_team_profile': return handleTeamProfile(args);
      case 'get_venue_hub': return handleVenueHub(args);
      case 'get_standings': return handleStandings();
      case 'get_trend': return handleTrend(args);
      case 'list_trends': return handleListTrends(args);
      case 'get_player_h2h': return handlePlayerH2H(args);
      case 'get_team_h2h': return handleTeamH2H(args);
      case 'get_season_stats': return handleSeasonStats(args);
      default: return ok({ error: 'unknown_tool', tool: name });
    }
  } catch (err) {
    return ok({ error: 'tool_error', tool: name, message: err instanceof Error ? err.message : String(err) });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
