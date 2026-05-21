# CricketStudio MCP server

> Citation infrastructure for cricket. **23 tools** exposing IPL 2026 + MLC atomic
> claims with provenance, sample-size floors, and stable canonical URLs to
> any MCP-compatible client (Claude Desktop, Cursor, ChatGPT Connectors, …).
>
> **Reference page:** https://players.cricketstudio.ai/mcp
> **Status:** v0.3.0 · stdio MCP, snapshot-bundled · MIT (code) · CC BY 4.0 (data)
>
> Every entity in this bundle is keyed by a public canonical slug
> (`jasprit-bumrah`, `mi`, `wankhede-stadium`). Upstream-provider numeric
> IDs (Sportmonks, CricketMind, ESPNcricinfo bare IDs) are not shipped.

This is the **public, install-by-npx** form. Every numeric response carries
`canonicalUrl` + `dataAsOf` so an LLM citing the answer can disclose
freshness and link back to the underlying page.

## Wire into Claude Desktop

```jsonc
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "cricketstudio": {
      "command": "npx",
      "args": ["-y", "github:i-m-arul/cricketstudio-mcp"]
    }
  }
}
```

Restart Claude Desktop. `cricketstudio` appears in the MCP servers list.

## Tools (v0.3.0)

All 23 work fully against the bundled snapshot. Each tool returns a
`canonicalUrl` + `dataAsOf`. See https://players.cricketstudio.ai/mcp
for the doctrine §10 reference.

### IPL 2026 (15)

| Tool | Maps to URL |
|---|---|
| `get_dataset_summary` | `/` |
| `search_players` | n/a |
| `get_player_profile` | `/players/{slug}` |
| `get_player_pillar` | `/players/{slug}` (filtered) |
| `list_atomic_claims` | various |
| `compare_players` | `/compare/players?slugs=…` |
| `get_team_profile` | `/teams/{slug}` |
| `get_team_h2h` | `/teams/{a}/vs/{b}` |
| `get_venue_hub` | `/venues/{slug}` |
| `get_standings` | `/standings` |
| `get_trend` | `/trends/{id}` |
| `list_trends` | `/trends` |
| `get_player_h2h` | `/h2h/{batter-vs-bowler}` |
| `get_season_stats` | `/season/ipl-2026/{aspect}` |
| `get_fielding_stats` | `/players/{slug}` · `/season/ipl-2026/catches` |

### Major League Cricket (8)

| Tool | Maps to URL |
|---|---|
| `get_mlc_dataset_summary` | `/leagues/mlc` |
| `search_mlc_players` | `/leagues/mlc/players` |
| `get_mlc_player_profile` | `/leagues/mlc/players/{slug}` |
| `get_mlc_team_profile` | `/leagues/mlc/teams/{slug}` |
| `get_mlc_match` | `/leagues/mlc/matches/{id}` |
| `get_mlc_match_claim` | `/leagues/mlc/matches/{id}/c/{kind}` |
| `list_mlc_matches` | `/leagues/mlc/matches` |
| `list_mlc_leaderboards` | `/leagues/mlc/leaderboards/{aspect}` |

**New in v0.3.0:** all 8 MLC tools (Cricsheet, CC BY 3.0) + IPL
`compare_players` + `get_fielding_stats`. This brings the public npx
bundle to parity with the documented surface at
`players.cricketstudio.ai/mcp` on everything that doesn't require live
ball-by-ball state. **v0.2.0** added `get_team_h2h` and fixed a latent
`get_player_h2h` shape bug.

The 5 remaining tools the hosted catalog advertises —
`list_fixtures`, `get_match_state`, `get_match_recap`,
`get_partnerships`, `get_dismissal_analysis` — are **not** in this npx
bundle by design: they need upstream fixture IDs or ball-level event
arrays that are deliberately stripped from the public snapshot (the
moat). They ship in Phase B at `mcp.cricketstudio.ai` over the HTTP
transport with live data.

## Architecture (why snapshot)

The CricketStudio publisher at `players.cricketstudio.ai` is the single
source of truth — its build pipeline aggregates ball-by-ball through the
SETU canonical aggregator into `data/_season-stats.json`, then projects
into every leaderboard surface (six P1-P6 parity contracts enforce that
"Top 5 batters" matches "Top run-scorers" exactly).

The aggregator algorithm itself is the moat — it stays in the private
monorepo. **This public repo bundles the pre-computed PROJECTION** of
that data: every number you can read here is also readable on the
rendered HTML at `players.cricketstudio.ai`. No new information is
exposed; only a different access path.

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

The hosted HTTP transport at `mcp.cricketstudio.ai` (Phase B) collapses
this back into a single endpoint — same shape, no snapshot, live data.

## Snapshot freshness

`data/snapshot/metadata.json` carries the source commit + generation
timestamp. The private monorepo runs `build-mcp-snapshot.mjs` on a cron
and pushes the snapshot here; typical lag is < 30 minutes during IPL
match windows. Every tool response includes `dataAsOf` so the LLM can
disclose freshness in cites.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** CC BY 4.0 — free to cite with attribution to *CricketStudio*
  (https://players.cricketstudio.ai). Every tool response includes a
  `canonicalUrl` so attribution flows automatically.

## Local development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm start               # tsx src/server.ts (stdio)
```

Smoke-test (no MCP client needed) — spawns the server over stdio,
drives it with JSON-RPC, and asserts every advertised tool returns a
non-error payload with `dataAsOf`:

```bash
npm run smoke
```

Expect `SMOKE TEST PASSED — 23 tools advertised, 23 calls green.` CI
(`.github/workflows/ci.yml`) runs `typecheck` + `smoke` on every push
and weekly on a cron.

## Roadmap

- **v0.1.x** — stdio MCP with bundled snapshot
- **v0.2** — `get_team_h2h` added; `get_player_h2h` shape bug fixed;
  `npm run smoke` assertion harness + CI (typecheck + smoke on push,
  weekly cron)
- **v0.3** — full feasible parity with the hosted catalog: 8 MLC tools
  + IPL `compare_players` + `get_fielding_stats` → 23 tools (you are here)
- **v0.4** — daily snapshot push from the private monorepo via GitHub
  Action; historical IPL season leaderboards
- **Phase B** — HTTP + SSE transport at `mcp.cricketstudio.ai` with the
  full catalog including live ball-by-ball (`list_fixtures`,
  `get_match_state`, `get_match_recap`, `get_partnerships`,
  `get_dismissal_analysis`); API-key tier mapping; Stripe metering

## Methodology

The five non-negotiables that govern every claim:

1. **Sample-size floors** — ≥30 batting balls, ≥15 bowling deliveries,
   ≥3 venue fixtures, ≥5 H2H deliveries, ≥3 matches for trends
2. **Date windows explicit** on every claim (no "all-time" labels)
3. **Provenance to ball-by-ball** in every response
4. **Atomic claim format under 30 words**
5. **Sub-4-hour data-freshness SLA** (95th percentile)

Full doctrine at https://players.cricketstudio.ai/about and the live
catalog at https://players.cricketstudio.ai/mcp.

---

Built by **Arul Anand** · Chennai & Frisco · cricket enthusiast and data
engineer. Questions / bugs / requests: open an issue on this repo.
