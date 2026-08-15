# Location Drive MCP Server

Query the Location Drive location-data platform from Claude, Cursor, or any
MCP-compatible AI client: global POI search, graded building-footprint
polygons, brand intelligence, and premium data packs (EV charging, fuel
prices, menus, hotel rates) — using your own Location Drive API key, so your
plan, quotas, and usage dashboard apply exactly as with direct API calls.

## Tools

| Tool | What it does |
|---|---|
| `search_places` | Search the global POI database by name/keyword |
| `find_nearby` | Distance-sorted places around a coordinate |
| `get_place_details` | Full record by ID; premium fields via `fields` on eligible plans |
| `get_place_context` | LLM-ready summary + structured data for one place |
| `get_building_polygon` | GeoJSON footprint with A–E accuracy grade (Starter+) |
| `find_building_at_point` | Reverse lookup: which building contains this coordinate (Starter+) |
| `brand_footprint` | Store counts, open-now, coverage, avg rating for a brand |
| `data_coverage` | Per-country POI counts and polygon coverage stats |

## Setup — Local (recommended for individuals)

Get an API key at [locationdrive.com](https://locationdrive.com) → Dashboard → API Keys.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "locationdrive": {
      "command": "npx",
      "args": ["-y", "@locationdrive/mcp"],
      "env": { "LOCATIONDRIVE_API_KEY": "ld_live_YOUR_KEY" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add locationdrive -e LOCATIONDRIVE_API_KEY=ld_live_YOUR_KEY -- npx -y @locationdrive/mcp
```

**Cursor / other MCP clients:** command `npx -y @locationdrive/mcp` with the
`LOCATIONDRIVE_API_KEY` environment variable.

## Setup — Remote (hosted)

The same server runs hosted at `https://mcp.locationdrive.com/mcp`
(Streamable HTTP). Configure your client with that URL and header:

```
Authorization: Bearer ld_live_YOUR_KEY
```

## Try it

Ask your AI client things like:

- *"What data coverage does Location Drive have for Anguilla?"*
- *"Find restaurants within 1 km of 18.2170, -63.0578."*
- *"Which building sits at 18.2168, -63.0581, and what's its accuracy grade?"*
- *"How many Starbucks locations are there worldwide, by country?"*

## Notes

- Plan gating is enforced server-side: polygon tools require Starter+, and
  premium fields (EV, fuel, menus, hotel rates, reviews) require Business+.
  The tools return clear upgrade messages rather than empty data.
- Rate limits and monthly quotas match your plan; a `429` from heavy agent
  usage means the key's quota is exhausted.
- `ld_test_` keys work and return synthetic data without counting against
  quotas — useful for trying the integration.
- The hosted endpoint adds no rate limiting of its own: your API key's
  plan limits (enforced by api.locationdrive.com) are the backstop, and
  unauthenticated requests are rejected immediately.

## Development

```bash
npm install
npm run build      # compiles src/ and typechecks api/
npm run inspect   # MCP Inspector against the local build
LOCATIONDRIVE_API_KEY=ld_live_x node scripts/smoke.mjs   # live API smoke test
```

MIT © Location Drive, LLC
