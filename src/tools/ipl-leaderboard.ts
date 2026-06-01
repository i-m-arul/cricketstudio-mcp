/**
 * src/tools/ipl-leaderboard.ts
 *
 * Helper module for the get_ipl_leaderboard tool (tool #29).
 * Maps the 35 IPL leaderboard aspect slugs to human-readable
 * descriptions and formats, and provides a response formatter.
 *
 * Source-of-truth for slug definitions:
 *   lib/ipl-historical/leaderboard-aspects.ts (cricketstudio main repo)
 *
 * Actual numeric data is read from the ipl-historical snapshot in
 * data/_season-stats-ipl-historical.json (via snapshot.ts).
 * This module handles metadata + formatting only.
 */

// ─── Aspect metadata ──────────────────────────────────────────────────

export interface LeaderboardAspectMeta {
  slug: string;
  title: string;
  description: string;
  /** Column header shown next to each player name. */
  unit: string;
  /** When true, lower values rank higher (economy, average, balls-to-milestone). */
  ascending: boolean;
  /** Human-readable sample-size floor note, or null when there is none. */
  floorNote: string | null;
  /**
   * When true this aspect only covers IPL 2026 data; no historical
   * per-season breakdown is available.
   */
  liveSeasonOnly: boolean;
}

export const LEADERBOARD_ASPECTS: LeaderboardAspectMeta[] = [
  // ── Orange / Purple cap ─────────────────────────────────────────────
  {
    slug: 'orange-cap',
    title: 'Orange cap — most runs',
    description:
      'Career top run-scorers across the IPL historical archive (1,169 matches, 18 seasons 2007/08–2025). All-time orange-cap leaderboard.',
    unit: 'Runs',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },
  {
    slug: 'purple-cap',
    title: 'Purple cap — most wickets',
    description:
      'Career top wicket-takers across the IPL historical archive (1,169 matches, 18 seasons 2007/08–2025).',
    unit: 'Wickets',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },

  // ── Batting aggregates ───────────────────────────────────────────────
  {
    slug: 'strike-rate',
    title: 'Highest batting strike rates',
    description:
      'Best batting strike rates (runs per 100 balls) across IPL career. Minimum sample floor applied.',
    unit: 'Strike rate',
    ascending: false,
    floorNote: 'Minimum 150 balls faced.',
    liveSeasonOnly: false,
  },
  {
    slug: 'batting-average',
    title: 'Best batting average',
    description:
      'Highest batting averages (runs per dismissal) across IPL career. Minimum sample floor applied.',
    unit: 'Average',
    ascending: false,
    floorNote: 'Minimum 150 balls faced.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-fifties',
    title: 'Most half-centuries (50s)',
    description:
      'Most innings of 50–99 runs in IPL career (2007/08–2025). Centuries (100+) are counted separately.',
    unit: '50s',
    ascending: false,
    floorNote: 'Minimum 3 innings.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-hundreds',
    title: 'Most centuries (100s)',
    description:
      'Most innings of 100+ runs in IPL career (2007/08–2025). T20 centuries are rare — this is the complete list.',
    unit: '100s',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },
  {
    slug: 'most-sixes',
    title: 'Most sixes',
    description: 'Top six-hitters across captured IPL matches (career).',
    unit: 'Sixes',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },
  {
    slug: 'most-fours',
    title: 'Most fours',
    description: 'Top boundary-hitters (fours) across captured IPL matches (career).',
    unit: 'Fours',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },

  // ── Bowling aggregates ───────────────────────────────────────────────
  {
    slug: 'economy-leaders',
    title: 'Best bowling economy rates',
    description:
      'Lowest bowling economy rates (runs per over) across IPL career. Lower is better. Minimum sample floor applied.',
    unit: 'Economy (RPO)',
    ascending: true,
    floorNote: 'Minimum 240 legal deliveries bowled.',
    liveSeasonOnly: false,
  },
  {
    slug: 'bowling-average',
    title: 'Best bowling average',
    description:
      'Lowest bowling averages (runs per wicket) across IPL career. Lower is better.',
    unit: 'Average (R/W)',
    ascending: true,
    floorNote: 'Minimum 300 legal deliveries bowled.',
    liveSeasonOnly: false,
  },
  {
    slug: 'bowling-strike-rate',
    title: 'Best bowling strike rate',
    description:
      'Fewest balls per wicket across IPL career. Lower is better — measures how quickly a bowler takes wickets.',
    unit: 'Balls per wicket',
    ascending: true,
    floorNote: 'Minimum 300 legal deliveries bowled.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-dot-balls',
    title: 'Most dot balls bowled',
    description:
      'Most legal deliveries where the batter scored 0 runs across IPL career. Measures consistent pressure bowling.',
    unit: 'Dot balls',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },
  {
    slug: 'runs-conceded',
    title: 'Most runs conceded (bowling)',
    description:
      'Most runs conceded while bowling across IPL career — a workload indicator for high-volume bowlers.',
    unit: 'Runs conceded',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: false,
  },
  {
    slug: 'maiden-overs',
    title: 'Most maiden overs',
    description:
      'Most complete overs (6 legal deliveries) in which the bowler conceded zero runs — no batting runs, no wides, no no-ball penalties. IPL 2026.',
    unit: 'Maiden overs',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: true,
  },
  {
    slug: 'hat-tricks',
    title: 'Hat-tricks',
    description:
      '3 wickets on 3 consecutive legal deliveries by the same bowler in the same innings. Run-outs excluded. IPL 2026.',
    unit: 'Hat-tricks',
    ascending: false,
    floorNote: null,
    liveSeasonOnly: true,
  },

  // ── Milestone / speed ────────────────────────────────────────────────
  {
    slug: 'fastest-fifty',
    title: 'Fastest half-centuries (fewest balls to 50)',
    description:
      'Fewest deliveries faced to score 50 runs in an IPL 2026 innings. Ball-by-ball verified.',
    unit: 'Balls to 50',
    ascending: true,
    floorNote: null,
    liveSeasonOnly: true,
  },
  {
    slug: 'fastest-hundred',
    title: 'Fastest centuries (fewest balls to 100)',
    description:
      'Fewest deliveries faced to score 100 runs in an IPL 2026 innings. Ball-by-ball verified.',
    unit: 'Balls to 100',
    ascending: true,
    floorNote: null,
    liveSeasonOnly: true,
  },

  // ── Powerplay batting ────────────────────────────────────────────────
  {
    slug: 'pp-runs',
    title: 'Most powerplay runs (overs 1–6)',
    description:
      'Most runs scored in powerplay overs (1–6) across IPL career. Measures powerplay batting contribution.',
    unit: 'PP runs',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in powerplay.',
    liveSeasonOnly: false,
  },
  {
    slug: 'powerplay-runs',
    title: 'Powerplay runs — career leaders',
    description:
      'Aggregate powerplay runs (overs 1–6) across IPL career. Alias for pp-runs; same projector.',
    unit: 'PP runs',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in powerplay.',
    liveSeasonOnly: false,
  },
  {
    slug: 'pp-sr-batting',
    title: 'Highest powerplay batting strike rates',
    description:
      'Best batting strike rates in the powerplay (overs 1–6) across IPL career.',
    unit: 'PP strike rate',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in powerplay overs 1–6.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-sixes-pp',
    title: 'Most sixes in the powerplay',
    description: 'Most sixes hit in powerplay overs (1–6) across IPL career.',
    unit: 'PP sixes',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in powerplay.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-fours-pp',
    title: 'Most fours in the powerplay',
    description: 'Most fours hit in powerplay overs (1–6) across IPL career.',
    unit: 'PP fours',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in powerplay.',
    liveSeasonOnly: false,
  },

  // ── Powerplay bowling ────────────────────────────────────────────────
  {
    slug: 'powerplay-economy',
    title: 'Best powerplay economy (overs 1–6)',
    description:
      'Lowest bowling economy rates in the powerplay (overs 1–6) across IPL career. Lower is better.',
    unit: 'PP econ (RPO)',
    ascending: true,
    floorNote: 'Minimum 18 legal deliveries bowled in overs 1–6.',
    liveSeasonOnly: false,
  },
  {
    slug: 'powerplay-wickets',
    title: 'Most powerplay wickets (overs 1–6)',
    description:
      'Most wickets taken in powerplay overs (1–6) across IPL career. Measures early-over bowling impact.',
    unit: 'PP wickets',
    ascending: false,
    floorNote: 'Minimum 18 legal deliveries in powerplay.',
    liveSeasonOnly: false,
  },

  // ── Middle overs batting ─────────────────────────────────────────────
  {
    slug: 'middle-runs',
    title: 'Most middle-overs runs (overs 7–15)',
    description:
      'Most runs scored in middle overs (7–15) across IPL career. The anchor phase where dot balls and wickets set up the finish.',
    unit: 'Middle runs',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in middle overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-sixes-middle',
    title: 'Most sixes in the middle overs',
    description: 'Most sixes hit in middle overs (7–15) across IPL career.',
    unit: 'Middle sixes',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in middle overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-fours-middle',
    title: 'Most fours in the middle overs',
    description: 'Most fours hit in middle overs (7–15) across IPL career.',
    unit: 'Middle fours',
    ascending: false,
    floorNote: 'Minimum 150 balls faced in middle overs.',
    liveSeasonOnly: false,
  },

  // ── Middle overs bowling ─────────────────────────────────────────────
  {
    slug: 'middle-wickets',
    title: 'Most middle-overs wickets (overs 7–15)',
    description: 'Most wickets taken in the middle overs (7–15) across IPL career.',
    unit: 'Middle wickets',
    ascending: false,
    floorNote: 'Minimum 240 legal deliveries in middle overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'middle-economy',
    title: 'Best middle-overs economy (overs 7–15)',
    description:
      'Lowest bowling economy rate in the middle overs (7–15) across IPL career. Lower is better.',
    unit: 'Middle econ (RPO)',
    ascending: true,
    floorNote: 'Minimum 240 legal deliveries in middle overs.',
    liveSeasonOnly: false,
  },

  // ── Death overs batting ──────────────────────────────────────────────
  {
    slug: 'death-runs',
    title: 'Most death-overs runs (overs 16–20)',
    description:
      "Most runs scored in death overs (16–20) across IPL career. The finisher's arena.",
    unit: 'Death runs',
    ascending: false,
    floorNote: 'Minimum 20 balls faced in death overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'death-sr-batting',
    title: 'Highest death-overs batting strike rates',
    description:
      'Best batting strike rates in death overs (overs 17–20) across IPL career.',
    unit: 'Death SR',
    ascending: false,
    floorNote: 'Minimum 20 balls faced in death overs (17–20).',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-sixes-death',
    title: 'Most sixes in death overs',
    description: 'Most sixes hit in death overs (16–20) across IPL career.',
    unit: 'Death sixes',
    ascending: false,
    floorNote: 'Minimum 20 balls faced in death overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'most-fours-death',
    title: 'Most fours in death overs',
    description: 'Most fours hit in death overs (16–20) across IPL career.',
    unit: 'Death fours',
    ascending: false,
    floorNote: 'Minimum 20 balls faced in death overs.',
    liveSeasonOnly: false,
  },

  // ── Death overs bowling ──────────────────────────────────────────────
  {
    slug: 'death-wickets',
    title: 'Most death-overs wickets (overs 16–20)',
    description:
      'Most wickets taken in death overs (16–20) across IPL career. Measures death-bowling impact.',
    unit: 'Death wickets',
    ascending: false,
    floorNote: 'Minimum 240 legal deliveries in death overs.',
    liveSeasonOnly: false,
  },
  {
    slug: 'death-overs-economy',
    title: 'Best death-overs economy (overs 17–20)',
    description:
      'Lowest bowling economy rates in death overs (overs 17–20) across IPL career. Lower is better.',
    unit: 'Death econ (RPO)',
    ascending: true,
    floorNote: 'Minimum 240 legal deliveries bowled in overs 17–20.',
    liveSeasonOnly: false,
  },
];

// ─── Lookup helper ────────────────────────────────────────────────────

/**
 * getAspectMeta — look up metadata for a leaderboard aspect slug.
 * Returns null when the slug is unknown.
 */
export function getAspectMeta(slug: string): LeaderboardAspectMeta | null {
  return LEADERBOARD_ASPECTS.find((a) => a.slug === slug) ?? null;
}

// ─── Response formatter ───────────────────────────────────────────────

/**
 * A single row in a leaderboard response, as returned by the snapshot
 * layer. Only the fields we need for formatting are required here;
 * the full row may carry additional fields (team, matches, etc.).
 */
export interface LeaderboardRow {
  rank?: number;
  player: string;
  /** Player profile slug, e.g. "virat-kohli". May be absent for historical stubs. */
  slug?: string;
  /** The primary metric value (runs, wickets, economy, etc.). */
  value: number;
  /** Number of matches / innings / deliveries backing the stat (sample size). */
  sampleSize?: number;
  /** Season label, e.g. "2023" or "2007/08". Present only in per-season mode. */
  season?: string;
  /** Team short code, e.g. "rcb". Optional. */
  team?: string;
}

/**
 * formatLeaderboardResponse — render a leaderboard result set into a
 * compact, LLM-friendly plain-text block.
 *
 * @param aspect   The aspect slug, e.g. "orange-cap"
 * @param season   Optional season filter applied to the query, e.g. "2023"
 * @param data     Array of LeaderboardRow objects (already sorted by caller)
 * @returns        A multi-line string suitable for embedding in an MCP tool response
 */
export function formatLeaderboardResponse(
  aspect: string,
  season: string | undefined,
  data: LeaderboardRow[],
): string {
  const meta = getAspectMeta(aspect);

  if (!meta) {
    return `Unknown leaderboard aspect "${aspect}". Call list_ipl_leaderboards to see valid slugs.`;
  }

  if (data.length === 0) {
    const seasonNote = season ? ` for season ${season}` : '';
    return `No data found for "${meta.title}"${seasonNote}. The aspect may require a season that is not yet seeded, or all players fell below the sample-size floor.`;
  }

  const lines: string[] = [];

  // Header
  const seasonLabel = season ? ` — ${season}` : ' — all-time (2007/08–2025)';
  const liveNote = meta.liveSeasonOnly ? ' — IPL 2026 only' : '';
  lines.push(`${meta.title}${liveNote ? liveNote : seasonLabel}`);
  lines.push(meta.description);
  lines.push('');

  // Column widths
  const rankWidth = 4;
  const nameWidth = Math.min(28, Math.max(16, ...data.map((r) => r.player.length)) + 1);
  const valWidth = Math.max(meta.unit.length, 8);

  // Header row
  const header =
    'Rank'.padEnd(rankWidth) +
    'Player'.padEnd(nameWidth) +
    meta.unit.padStart(valWidth);
  lines.push(header);
  lines.push('-'.repeat(rankWidth + nameWidth + valWidth));

  // Data rows
  data.forEach((row, idx) => {
    const rank = row.rank ?? idx + 1;
    const name = row.player.length > nameWidth - 1
      ? row.player.slice(0, nameWidth - 4) + '...'
      : row.player;
    const val = formatValue(row.value, meta);
    lines.push(
      String(rank).padEnd(rankWidth) +
        name.padEnd(nameWidth) +
        val.padStart(valWidth),
    );
  });

  lines.push('');

  // Sample-size / floor note
  if (meta.floorNote) {
    lines.push(`Floor: ${meta.floorNote}`);
  }

  // Window
  if (meta.liveSeasonOnly) {
    lines.push('Window: IPL 2026 (live season)');
  } else if (season) {
    lines.push(`Window: IPL ${season}`);
  } else {
    lines.push('Window: IPL all-time (2007/08–2025, 1,169 matches, 18 seasons)');
  }

  // Provenance
  lines.push('Source: CricketStudio aggregation of Cricsheet ball-by-ball data (CC BY 3.0)');
  lines.push(`Canonical URL: https://players.cricketstudio.ai/leagues/ipl/leaderboards/${aspect}`);

  return lines.join('\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────

function formatValue(n: number, meta: LeaderboardAspectMeta): string {
  const unit = meta.unit.toLowerCase();

  // Integer units — no decimal places
  if (
    unit.includes('runs') ||
    unit.includes('wickets') ||
    unit.includes('sixes') ||
    unit.includes('fours') ||
    unit.includes('dot') ||
    unit.includes('balls to') ||
    unit.includes('maiden') ||
    unit.includes('hat-trick') ||
    unit.includes('50s') ||
    unit.includes('100s') ||
    unit.includes('ducks')
  ) {
    return Math.round(n).toLocaleString();
  }

  // Strike rate — 1 decimal place
  if (unit.includes('strike rate') || unit === 'pp strike rate' || unit === 'death sr') {
    return n.toFixed(1);
  }

  // Economy, average — 2 decimal places
  return n.toFixed(2);
}
