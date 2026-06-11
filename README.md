# cricketstudio-mcp

[![npm version](https://img.shields.io/npm/v/@cricketstudio/mcp)](https://www.npmjs.com/package/@cricketstudio/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Data: CC BY 4.0](https://img.shields.io/badge/Data-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Citation infrastructure for cricket — 29 MCP tools, zero network calls, 1,307 matches, 309,992 deliveries.**

---

## What is this?

CricketStudio MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-compatible AI client — Claude Desktop, Cursor, ChatGPT Connectors, and others — structured, citable access to cricket data. Every response carries a `canonicalUrl` back to `players.cricketstudio.ai`, an explicit date window, a sample-size count, and a provenance trail to the underlying ball-by-ball corpus. The data is fully bundled in `data/snapshot/` — tool answers are computed locally with no data-fetch calls, no API keys, and no rate limits. (The package sends one anonymous startup ping for usage counts; disable it with `CRICKETSTUDIO_NO_TELEMETRY=1`.)

The corpus covers **IPL 2026** (complete season, RCB champions), **18 seasons of IPL history** (2007/08–2025, Cricsheet), and **Major League Cricket 2023–2026** (Cricsheet). Batting claims require a minimum of 30 balls faced; bowling claims require 15 deliveries. Claims that do not clear those floors are not surfaced.

---

## Installation

### Claude Desktop

Add to your Claude Desktop config file and restart the app.

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cricketstudio": {
      "command": "npx",
      "args": ["cricketstudio-mcp"]
    }
  }
}
```

### Other MCP clients

```bash
npx cricketstudio-mcp
```

Any MCP client that supports the stdio transport can use this command directly. The server starts on stdin/stdout and requires Node 20 or later.

---

## Tools

All 32 tools work fully against the bundled snapshot. Each response includes `canonicalUrl`, `dataAsOf`, and `sampleSize`.

### IPL 2026 (20 tools)

| Tool | What it returns | Maps to URL |
|---|---|---|
| `get_dataset_summary` | Top-level corpus overview: seasons, matches, players, deliveries | `/` |
| `search_players` | Player discovery by name or team | n/a |
| `get_player_profile` | Headline stats across all five pillars (P1–P5) | `/players/{slug}` |
| `get_player_pillar` | Claims from a specific pillar (P1 recaps, P2 moments, P3 form, P4 season, P5 notebook) | `/players/{slug}` filtered |
| `list_atomic_claims` | Filtered query across all ClaimReview entries | various |
| `compare_players` | Side-by-side stat comparison for two or more players | `/compare/players?slugs=…` |
| `get_team_profile` | Team headline stats and season summary | `/teams/{slug}` |
| `get_team_h2h` | Head-to-head record between two franchises | `/teams/{a}/vs/{b}` |
| `get_venue_hub` | Aggregated venue patterns: par scores, toss impact, phase splits | `/venues/{slug}` |
| `get_standings` | IPL 2026 points table with NRR | `/standings` |
| `get_trend` | A single trend insight with full claim set | `/trends/{id}` |
| `list_trends` | Browse trends by category (conditional, momentum, venue, toss, anomaly) | `/trends` |
| `get_player_h2h` | Batter vs bowler matchup record | `/h2h/{batter}-vs-{bowler}` |
| `get_season_stats` | Season leaderboard for a given aspect (runs, wickets, strike rate, economy, …) | `/season/ipl-2026/{aspect}` |
| `get_fielding_stats` | Catches, run-outs, and fielding contributions for a player or the full season | `/players/{slug}` · `/season/ipl-2026/catches` |
| `get_partnerships` | Partnership records for a match or player pair | `/matches/{id}` |
| `get_dismissal_analysis` | Dismissal mode breakdown for a batter or bowler | `/players/{slug}` |
| `list_fixtures` | Full schedule with match status, venue, and result | `/matches` |
| `get_match_state` | Live or final scorecard with ball-by-ball state | `/matches/{fixture-id}` |
| `get_match_recap` | Atomic claim set for a completed match | `/matches/{fixture-id}` |

### Major League Cricket (8 tools)

| Tool | What it returns | Maps to URL |
|---|---|---|
| `get_mlc_dataset_summary` | MLC corpus overview: seasons, matches, players, deliveries | `/leagues/mlc` |
| `search_mlc_players` | Player discovery within the MLC corpus | `/leagues/mlc/players` |
| `get_mlc_player_profile` | MLC career and season stats for a player | `/leagues/mlc/players/{slug}` |
| `get_mlc_team_profile` | Franchise profile and season history | `/leagues/mlc/teams/{slug}` |
| `get_mlc_match` | Match scorecard and key claims | `/leagues/mlc/matches/{id}` |
| `get_mlc_match_claim` | A single typed claim for an MLC match (top scorer, best figures, etc.) | `/leagues/mlc/matches/{id}/c/{kind}` |
| `list_mlc_matches` | All MLC matches with status and results | `/leagues/mlc/matches` |
| `list_mlc_leaderboards` | Season or all-time leaderboard for a given MLC aspect | `/leagues/mlc/leaderboards/{aspect}` |

### IPL Career / Historical (1 tool)

| Tool | What it returns | Maps to URL |
|---|---|---|
| `get_ipl_leaderboard` | All-time IPL leaderboard for any aspect across 18 seasons (2007/08–2025) — runs, wickets, sixes, centuries, economy, and more | `/leagues/ipl/leaderboards/{aspect}` |

### Knowledge Graph (L3) (3 tools)

Slug-keyed traversal over CricketStudio's entity graph. Nodes are players and franchises; edges are `plays_for` (squad membership) and `faced`/`dismissed_by` (batter-vs-bowler matchups, mirroring the `get_player_h2h` pair set).

| Tool | What it returns | Maps to URL |
|---|---|---|
| `get_related_entities` | Entities connected to a player or franchise, by edge type and direction | `/players/{slug}` · `/teams/{slug}` |
| `get_player_connections` | A player's franchise + most-faced bowlers + bowlers who dismissed them most, in one call | `/players/{slug}` |
| `get_graph_path` | Shortest connection (≤4 hops) between two entities, e.g. two players via a shared franchise | n/a |

---

## Example queries

Once connected in Claude Desktop, you can ask questions like:

- "Who won IPL 2026?"
- "What did Kohli score in the final?"
- "Who leads the all-time IPL sixes leaderboard?"
- "Show me Vaibhav Suryavanshi's IPL 2026 stats"
- "What's the RCB vs GT head-to-head record?"
- "Which venues favour the team batting first in IPL 2026?"
- "Who has the best death-over economy in MLC 2025?"
- "List the top wicket-takers in IPL history"

---

## Data

| Source | Coverage | License |
|---|---|---|
| Sportmonks | IPL 2026 ball-by-ball (complete season — RCB champions) | Licensed feed |
| Cricsheet | IPL historical, 18 seasons, 1,169 matches (2007/08–2025) | CC BY 3.0 |
| Cricsheet | MLC 2023–2026, 138 matches | CC BY 3.0 |

**Total corpus:** 1,307 matches · 309,992 ball-by-ball deliveries.

**Sample-size floors (publicly disclosed):**
- Batting claims: ≥30 balls faced
- Bowling claims: ≥15 deliveries
- Venue claims: ≥3 fixtures at the venue
- Trend claims: ≥3 matches forming the pattern

Claims that do not reach these floors are excluded — they are not suppressed with a placeholder, they are simply absent. This is the moat.

**Update cadence:** the private monorepo runs `build-mcp-snapshot.mjs` on a cron and pushes updated snapshots here. Typical lag during IPL match windows is under 30 minutes. Every tool response includes `dataAsOf` so an LLM citing the answer can disclose freshness explicitly.

**Data licence:** the bundled data is released under CC BY 4.0. Every tool response includes a `canonicalUrl` back to `players.cricketstudio.ai` so attribution flows automatically when an LLM cites an answer.

---

## Architecture

The CricketStudio publisher at `players.cricketstudio.ai` is the single source of truth. Its build pipeline aggregates ball-by-ball data through the SETU canonical aggregator into `data/_season-stats.json`, then projects into every leaderboard surface (six parity contracts enforce that "Top 5 batters" and "Top run-scorers" can never drift).

This public repo bundles the pre-computed projection of that data. Every number accessible here is also readable on the rendered HTML at `players.cricketstudio.ai`. No new information is exposed — only a different access path.

```
private monorepo                                     this repo (public)
─────────────────                                    ──────────────────
 build-mcp-snapshot.mjs ──▶  data/snapshot/*.json ──▶ src/server.ts
   ↑                                                       ↓
   ↑                                                  MCP client
   ↑                                                  (Claude, Cursor, …)
 ball-by-ball  →  SETU aggregator (private)
                  agent layer (private)
                  L2 conditional engine (private)
```

The aggregator algorithm stays in the private monorepo. The snapshot is what ships here.

---

## Methodology

Every claim in this package is governed by five non-negotiables:

1. **Sample-size floors** — ≥30 batting balls, ≥15 bowling deliveries, ≥3 venue fixtures, ≥5 H2H deliveries, ≥3 matches for trends. Disclosed publicly on every page.
2. **Explicit date windows** — every claim specifies its window (`ipl-2026`, `ipl-career`, `last-N-matches`). No "all-time" labels without a defined window.
3. **Provenance to ball-by-ball** — every numeric claim traces to a specific match, delivery count, and computation timestamp.
4. **Atomic claim format** — under 30 words, structured as `[Subject] [metric] [value] [comparator] [period]`.
5. **Sub-4-hour freshness SLA** — for IPL 2026 pages, time from match end to page update is under 4 hours at the 95th percentile.

Full methodology at https://players.cricketstudio.ai/about.

---

## Local development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm start               # stdio MCP server via tsx
```

Smoke-test without an MCP client — spawns the server over stdio, drives it with JSON-RPC, and asserts every advertised tool returns a non-error payload with `dataAsOf`:

```bash
npm run smoke
```

---

## Building something?

Register at **[cricketstudio.ai/developers](https://cricketstudio.ai/developers)** to get early access to the hosted HTTP transport (`mcp.cricketstudio.ai`), live ball-by-ball endpoints, API-key tiers, and the full 29-tool catalog with live data rather than snapshots.

---

## License

- **Code:** MIT — see [`LICENSE`](./LICENSE)
- **Data:** CC BY 4.0 — free to cite with attribution to *CricketStudio* (`https://players.cricketstudio.ai`). Attribution flows automatically via the `canonicalUrl` field in every tool response.

---

Built by **Arul Anand** · Chennai & Frisco · cricket enthusiast and data engineer.
Questions, bugs, or requests: [open an issue](https://github.com/i-m-arul/cricketstudio-mcp/issues) or visit [players.cricketstudio.ai/mcp](https://players.cricketstudio.ai/mcp).
