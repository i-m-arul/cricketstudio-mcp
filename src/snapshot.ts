/**
 * snapshot.ts — Bundled data snapshot accessor for cricketstudio-mcp.
 *
 * Reads JSON files from data/snapshot/ relative to the package root.
 * All files are loaded lazily and cached after the first read.
 * Files that don't exist yet (future snapshot slots) return safe empty
 * values rather than throwing, so callers can depend on this module
 * before every file ships.
 *
 * ESM only — uses import.meta.url to resolve the package root.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Package root resolution ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the package root (one level up from src/). */
const PKG_ROOT = resolve(__dirname, '..');
const SNAPSHOT_DIR = resolve(PKG_ROOT, 'data', 'snapshot');

// ─── Interfaces ───────────────────────────────────────────────────────

export interface PlayerClaim {
  id: string;
  pillar: string;
  headline: string;
  context?: string;
  sampleSize?: string;
  computedAt: string;
}

export interface PlayerSnapshot {
  slug: string;
  fullName: string;
  teamCode?: string;
  claims: PlayerClaim[];
  batting?: {
    runs: number;
    sr?: number;
    avg?: number;
  };
  bowling?: {
    wickets: number;
    econ?: number;
  };
}

export interface H2HPair {
  slug: string;
  batterSlug: string;
  batterName: string;
  bowlerSlug: string;
  bowlerName: string;
  deliveries: number;
  runs: number;
  sr: number;
  dismissals: number;
}

export interface StandingsRow {
  teamCode: string;
  teamName: string;
  played: number;
  won: number;
  lost: number;
  points: number;
  nrr: number;
}

export interface Trend {
  id: string;
  kind: string;
  hook: string;
  bigStat?: string;
  numbers?: Array<{ label: string; value: string | number }>;
}

export interface MatchSummary {
  id: string;
  home: string;
  away: string;
  date: string;
  status: string;
  result?: string;
  homeScore?: string;
  awayScore?: string;
}

// ─── Internal raw types (aligned with actual snapshot shapes) ─────────

/** Raw player record as stored in players.json (keyed dict by slug). */
interface RawPlayerRecord {
  slug: string;
  fullName: string;
  team?: string;
  role?: string;
  sameAs?: Record<string, string>;
  headlineClaimId?: string | null;
  claims: Array<{
    id: string;
    metric?: string;
    value?: string;
    period?: string;
    headline?: string;
    context?: string;
    pillar?: string;
    sampleSize?: string;
    computedAt?: string;
    stale?: boolean;
    provenance?: string;
  }>;
  batting?: { runs?: number; strikeRate?: number; average?: number; sr?: number; avg?: number };
  bowling?: { wickets?: number; economy?: number; econ?: number };
}

/** Raw H2H record as stored in h2h.json. */
interface RawH2HRecord {
  slug: string;
  batterSlug: string;
  batterName: string;
  bowlerSlug: string;
  bowlerName: string;
  deliveries?: number;
  runs?: number;
  strikeRate?: number;
  dismissals?: number;
}

/** Metadata record as stored in metadata.json. */
interface RawMetadata {
  generatedAt: string;
  counts: {
    players: number;
    teams: number;
    venues: number;
    trends: number;
    h2hPairs: number;
    teamH2hPairs?: number;
    mlc?: {
      players: number;
      teams: number;
      matches: number;
      leaderboards: number;
    };
  };
}

// ─── Lazy cache slots ─────────────────────────────────────────────────

let _players: PlayerSnapshot[] | null = null;
let _playerIndex: Map<string, PlayerSnapshot> | null = null;
let _standings: StandingsRow[] | null = null;
let _h2h: H2HPair[] | null = null;
let _h2hIndex: Map<string, H2HPair> | null = null;
let _trends: Trend[] | null = null;
let _trendIndex: Map<string, Trend> | null = null;
let _matches: MatchSummary[] | null = null;
let _matchIndex: Map<string, MatchSummary> | null = null;
let _seasonStats: unknown = undefined;          // undefined = not yet attempted
let _iplHistorical: unknown = undefined;
let _mlc: unknown = undefined;
let _meta: RawMetadata | null = null;

// ─── File helpers ─────────────────────────────────────────────────────

/**
 * Read and parse a JSON file from the snapshot directory.
 * Returns `null` when the file doesn't exist (future snapshot slot).
 * Throws on invalid JSON (data integrity error, not a missing-file case).
 */
function readJson<T>(filename: string): T | null {
  const p = resolve(SNAPSHOT_DIR, filename);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

// ─── Raw-to-typed coercions ───────────────────────────────────────────

/**
 * Coerce a RawPlayerRecord (from the players.json dict) into the
 * public PlayerSnapshot shape. The raw dict stores team as a full name
 * string and doesn't have a `teamCode` field; we derive a best-effort
 * three-letter code via the standing team-slug map.
 */
function coercePlayer(raw: RawPlayerRecord): PlayerSnapshot {
  const claims: PlayerClaim[] = (raw.claims ?? []).map((c) => ({
    id: c.id,
    pillar: c.pillar ?? 'P1',
    headline: c.headline ?? c.value ?? '',
    context: c.context,
    sampleSize: c.sampleSize,
    computedAt: c.computedAt ?? '',
  }));

  // Batting stats — handle both key-name variants (strikeRate/sr, average/avg)
  let batting: PlayerSnapshot['batting'] | undefined;
  if (raw.batting) {
    const r = raw.batting;
    const runs = r.runs ?? 0;
    batting = {
      runs,
      sr: r.sr ?? r.strikeRate,
      avg: r.avg ?? r.average,
    };
  }

  // Bowling stats
  let bowling: PlayerSnapshot['bowling'] | undefined;
  if (raw.bowling) {
    const r = raw.bowling;
    const wickets = r.wickets ?? 0;
    bowling = {
      wickets,
      econ: r.econ ?? r.economy,
    };
  }

  return {
    slug: raw.slug,
    fullName: raw.fullName,
    teamCode: raw.team ? rawTeamNameToCode(raw.team) : undefined,
    claims,
    batting,
    bowling,
  };
}

/** Best-effort map from full team name to 2–3 letter code. */
function rawTeamNameToCode(name: string): string | undefined {
  const MAP: Record<string, string> = {
    'Chennai Super Kings': 'CSK',
    'Delhi Capitals': 'DC',
    'Gujarat Titans': 'GT',
    'Kolkata Knight Riders': 'KKR',
    'Lucknow Super Giants': 'LSG',
    'Mumbai Indians': 'MI',
    'Punjab Kings': 'PBKS',
    'Rajasthan Royals': 'RR',
    'Royal Challengers Bengaluru': 'RCB',
    'Royal Challengers Bangalore': 'RCB',
    'Sunrisers Hyderabad': 'SRH',
  };
  return MAP[name];
}

function coerceH2H(raw: RawH2HRecord): H2HPair {
  return {
    slug: raw.slug,
    batterSlug: raw.batterSlug,
    batterName: raw.batterName,
    bowlerSlug: raw.bowlerSlug,
    bowlerName: raw.bowlerName,
    deliveries: raw.deliveries ?? 0,
    runs: raw.runs ?? 0,
    sr: raw.strikeRate ?? 0,
    dismissals: raw.dismissals ?? 0,
  };
}

// ─── Loader functions (lazy + memoised) ──────────────────────────────

function loadPlayers(): PlayerSnapshot[] {
  if (_players !== null) return _players;

  const raw = readJson<Record<string, RawPlayerRecord>>('players.json');
  if (!raw) {
    _players = [];
    return _players;
  }
  _players = Object.values(raw).map(coercePlayer);
  return _players;
}

function loadPlayerIndex(): Map<string, PlayerSnapshot> {
  if (_playerIndex !== null) return _playerIndex;
  _playerIndex = new Map(loadPlayers().map((p) => [p.slug, p]));
  return _playerIndex;
}

function loadStandings(): StandingsRow[] {
  if (_standings !== null) return _standings;
  const raw = readJson<StandingsRow[]>('standings.json');
  _standings = raw ?? [];
  return _standings;
}

function loadH2H(): H2HPair[] {
  if (_h2h !== null) return _h2h;
  const raw = readJson<RawH2HRecord[]>('h2h.json');
  _h2h = raw ? raw.map(coerceH2H) : [];
  return _h2h;
}

function loadH2HIndex(): Map<string, H2HPair> {
  if (_h2hIndex !== null) return _h2hIndex;
  _h2hIndex = new Map(loadH2H().map((p) => [p.slug, p]));
  return _h2hIndex;
}

function loadTrends(): Trend[] {
  if (_trends !== null) return _trends;
  const raw = readJson<Array<Record<string, unknown>>>('trends.json');
  if (!raw) {
    _trends = [];
    return _trends;
  }
  // Coerce: the raw trend uses `tease`/`detail` in addition to `hook`.
  // Prefer `hook` when present; fall back to `tease`.
  _trends = raw.map((t) => ({
    id: (t['id'] as string) ?? '',
    kind: (t['kind'] as string) ?? '',
    hook: (t['hook'] as string) ?? (t['tease'] as string) ?? '',
    bigStat: t['bigStat'] as string | undefined,
    numbers: t['numbers'] as Trend['numbers'] | undefined,
  }));
  return _trends;
}

function loadTrendIndex(): Map<string, Trend> {
  if (_trendIndex !== null) return _trendIndex;
  _trendIndex = new Map(loadTrends().map((t) => [t.id, t]));
  return _trendIndex;
}

function loadMatches(): MatchSummary[] {
  if (_matches !== null) return _matches;
  const raw = readJson<MatchSummary[]>('matches.json');
  _matches = raw ?? [];
  return _matches;
}

function loadMatchIndex(): Map<string, MatchSummary> {
  if (_matchIndex !== null) return _matchIndex;
  _matchIndex = new Map(loadMatches().map((m) => [m.id, m]));
  return _matchIndex;
}

function loadSeasonStats(): unknown {
  if (_seasonStats !== undefined) return _seasonStats;
  _seasonStats = readJson<unknown>('season-stats.json') ?? null;
  return _seasonStats;
}

function loadIplHistorical(): unknown {
  if (_iplHistorical !== undefined) return _iplHistorical;
  _iplHistorical = readJson<unknown>('ipl-historical.json') ?? null;
  return _iplHistorical;
}

function loadMlc(): unknown {
  if (_mlc !== undefined) return _mlc;
  // `mlc.json` is a future unified snapshot; the current snapshot
  // stores MLC data across mlc-league.json / mlc-players.json /
  // mlc-matches.json / mlc-teams.json. Prefer mlc.json when present.
  _mlc = readJson<unknown>('mlc.json') ?? null;
  return _mlc;
}

function loadMeta(): RawMetadata | null {
  if (_meta !== null) return _meta;
  _meta = readJson<RawMetadata>('metadata.json');
  return _meta;
}

// ─── Public accessor API ──────────────────────────────────────────────

/** All player profiles in the snapshot. */
export function getPlayers(): PlayerSnapshot[] {
  return loadPlayers();
}

/** Single player by slug; returns `null` when not found. */
export function getPlayer(slug: string): PlayerSnapshot | null {
  return loadPlayerIndex().get(slug) ?? null;
}

/**
 * Case-insensitive substring search across slug and fullName.
 * Returns up to 20 results for display purposes; callers can slice
 * further if needed.
 */
export function searchPlayers(q: string): PlayerSnapshot[] {
  if (!q || !q.trim()) return loadPlayers().slice(0, 20);
  const needle = q.trim().toLowerCase();
  return loadPlayers().filter(
    (p) =>
      p.slug.includes(needle) ||
      p.fullName.toLowerCase().includes(needle) ||
      (p.teamCode && p.teamCode.toLowerCase().includes(needle)),
  );
}

/** IPL 2026 standings table rows. Returns `[]` when file not yet built. */
export function getStandings(): StandingsRow[] {
  return loadStandings();
}

/** H2H pairs ordered by the snapshot sort (typically by deliveries desc). */
export function getH2HPairs(limit?: number): H2HPair[] {
  const all = loadH2H();
  return limit !== undefined ? all.slice(0, limit) : all;
}

/** Single H2H pair by slug (`{batter-slug}-vs-{bowler-slug}`); `null` if absent. */
export function getH2HPair(slug: string): H2HPair | null {
  return loadH2HIndex().get(slug) ?? null;
}

/** All trend insights. */
export function getTrends(): Trend[] {
  return loadTrends();
}

/** Single trend by id; `null` if absent. */
export function getTrend(id: string): Trend | null {
  return loadTrendIndex().get(id) ?? null;
}

/** Recent matches. Pass `limit` to cap the list. */
export function getMatches(limit?: number): MatchSummary[] {
  const all = loadMatches();
  return limit !== undefined ? all.slice(0, limit) : all;
}

/** Single match by id; `null` if absent. */
export function getMatch(id: string): MatchSummary | null {
  return loadMatchIndex().get(id) ?? null;
}

/**
 * CricketStudio canonical season-stats aggregates (IPL 2026).
 * Shape: `{ computedAt: string; bySlug: Record<string, ...> }`.
 * Returns `null` when the file is missing or empty.
 */
export function getSeasonStats(): unknown {
  return loadSeasonStats();
}

/**
 * IPL historical snapshot (18 seasons, Cricsheet corpus).
 * Returns `null` when the file has not been built yet.
 */
export function getIplHistorical(): unknown {
  return loadIplHistorical();
}

/**
 * MLC snapshot (2023–2026, Cricsheet corpus).
 * Returns `null` when the `mlc.json` unified file has not been built yet.
 * Use the per-file MLC accessors in server.ts for the current split form.
 */
export function getMlc(): unknown {
  return loadMlc();
}

/**
 * High-level snapshot metadata.
 * Returns corpus counts and the timestamp at which the snapshot was built.
 *
 * Falls back to safe zeroes when metadata.json is absent (dev environment
 * without a full snapshot).
 */
export function getSnapshotMeta(): {
  builtAt: string;
  corpus: { matches: number; deliveries: number; players: number };
} {
  const m = loadMeta();
  if (!m) {
    return {
      builtAt: new Date().toISOString(),
      corpus: { matches: 0, deliveries: 0, players: 0 },
    };
  }
  return {
    builtAt: m.generatedAt,
    corpus: {
      matches: 0,   // not tracked in metadata.json today; Phase B will add it
      deliveries: 0, // same — kept in data/_season-stats.json, not bundled here
      players: m.counts.players,
    },
  };
}

// ─── Knowledge graph (L3) ─────────────────────────────────────────────
//
// graph.json is a slug-keyed projection of CricketStudio's L3 knowledge
// graph: { nodes: { [slug]: { type, name } }, edges: [{ src, predicate,
// dst, props? }] }. Scope (moat parity with h2h.json): player + franchise
// nodes only; plays_for (full) + faced/dismissed_by (same pair set as
// h2h.json). Slug-keyed — no internal ids, no match/fixture nodes.

export interface GraphNode {
  /** Public slug — also the node's key. */
  slug: string;
  /** Entity type: 'player' | 'franchise'. */
  type: string;
  /** Display name. */
  name: string | null;
}

export interface GraphEdge {
  src: string;
  predicate: string;
  dst: string;
  /** Aggregate counts for faced/dismissed_by (deliveries/runs/dismissals). */
  props?: Record<string, number>;
}

interface RawGraphDoc {
  nodes?: Record<string, { type: string; name?: string | null }>;
  edges?: GraphEdge[];
}

export type GraphDirection = 'out' | 'in' | 'both';

let _graphNodes: Map<string, GraphNode> | null = null;
let _graphOut: Map<string, GraphEdge[]> | null = null;
let _graphIn: Map<string, GraphEdge[]> | null = null;

function loadGraph(): void {
  if (_graphNodes !== null) return;
  _graphNodes = new Map();
  _graphOut = new Map();
  _graphIn = new Map();
  const doc = readJson<RawGraphDoc>('graph.json');
  if (!doc) return; // graph.json not yet shipped → empty graph, fail-soft
  for (const [slug, n] of Object.entries(doc.nodes ?? {})) {
    _graphNodes.set(slug, { slug, type: n.type, name: n.name ?? null });
  }
  for (const e of doc.edges ?? []) {
    if (!_graphOut.has(e.src)) _graphOut.set(e.src, []);
    _graphOut.get(e.src)!.push(e);
    if (!_graphIn.has(e.dst)) _graphIn.set(e.dst, []);
    _graphIn.get(e.dst)!.push(e);
  }
}

/** A graph node by slug; `null` when absent. */
export function getGraphNode(slug: string): GraphNode | null {
  loadGraph();
  return _graphNodes!.get(slug) ?? null;
}

/** Edges incident to a node, optionally filtered by predicate + direction. */
export function graphEdges(
  slug: string,
  opts: { predicate?: string; direction?: GraphDirection } = {},
): GraphEdge[] {
  loadGraph();
  const { predicate, direction = 'out' } = opts;
  const collected: GraphEdge[] = [];
  if (direction === 'out' || direction === 'both') collected.push(...(_graphOut!.get(slug) ?? []));
  if (direction === 'in' || direction === 'both') collected.push(...(_graphIn!.get(slug) ?? []));
  return predicate ? collected.filter((e) => e.predicate === predicate) : collected;
}

/** Related nodes (the "other" endpoint of incident edges), de-duplicated. */
export function graphRelated(
  slug: string,
  opts: { predicate?: string; direction?: GraphDirection; limit?: number } = {},
): GraphNode[] {
  loadGraph();
  const { predicate, direction = 'out', limit = 25 } = opts;
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  const push = (otherSlug: string) => {
    if (seen.has(otherSlug)) return;
    const n = _graphNodes!.get(otherSlug);
    if (n) { seen.add(otherSlug); out.push(n); }
  };
  if (direction === 'out' || direction === 'both') {
    for (const e of _graphOut!.get(slug) ?? []) if (!predicate || e.predicate === predicate) push(e.dst);
  }
  if (direction === 'in' || direction === 'both') {
    for (const e of _graphIn!.get(slug) ?? []) if (!predicate || e.predicate === predicate) push(e.src);
  }
  return out.slice(0, limit);
}

/**
 * Shortest path between two slugs (treats edges as undirected for
 * connectivity), ≤ maxDepth hops. Returns the slug chain or `null`.
 * BFS, so the first path found is the shortest.
 */
export function graphPath(a: string, b: string, maxDepth = 4): string[] | null {
  loadGraph();
  if (!_graphNodes!.has(a) || !_graphNodes!.has(b)) return null;
  if (a === b) return [a];
  const visited = new Set<string>([a]);
  let frontier: string[][] = [[a]];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[][] = [];
    for (const pathSoFar of frontier) {
      const last = pathSoFar[pathSoFar.length - 1]!;
      const nbrs = new Set<string>();
      for (const e of _graphOut!.get(last) ?? []) nbrs.add(e.dst);
      for (const e of _graphIn!.get(last) ?? []) nbrs.add(e.src);
      for (const nb of nbrs) {
        if (visited.has(nb)) continue;
        const newPath = [...pathSoFar, nb];
        if (nb === b) return newPath;
        visited.add(nb);
        next.push(newPath);
      }
    }
    frontier = next;
  }
  return null;
}
