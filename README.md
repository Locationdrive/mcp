# Location Drive MCP Server

Query the Location Drive location-data platform from Claude, Cursor, or any
MCP-compatible AI client: global POI search, graded building-footprint
polygons, brand intelligence, and premium data packs (EV charging, fuel
prices, full menus, multi-site hotel rates, multi-year review history) — using
your own Location Drive API key, so your plan, quotas, and usage dashboard
apply exactly as with direct API calls.

## Tools

| Tool | What it does |
|---|---|
| `search_places` | Search the global POI database by name/keyword — counted per place returned (`limit`, default 5) |
| `find_nearby` | Distance-sorted places around a coordinate — counted per place returned (`limit`, default 8) |
| `get_place_details` | Full record by ID; request any field via `fields` — premium packs (menus, hotel rates, EV connectors, fuel, review text) included on every plan; `data_note` when a requested field has no data for that place |
| `get_place_context` | LLM-ready summary + structured data (sentiment keywords, not review text) for one place |
| `get_review_history` | Merged multi-year review text history, duplicates removed, plus sentiment summary |
| `scan_reviews` | Keyword scan of review text across up to 40 places near a point — matching snippets per place; neighborhood scale; costs the nearby search + 1 per scanned place, reported as `api_calls_counted` |
| `get_hotel_rates` | Compare room rates across booking sites for one hotel |
| `get_building_polygon` | GeoJSON footprint with A–E accuracy grade |
| `find_building_at_point` | Reverse lookup: which building contains this coordinate |
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
(Streamable HTTP) — no install needed. Authenticate with your key as a
Bearer header.

**Claude Code:**

```bash
claude mcp add --transport http locationdrive https://mcp.locationdrive.com/mcp \
  --header "Authorization: Bearer ld_live_YOUR_KEY"
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "locationdrive": {
      "url": "https://mcp.locationdrive.com/mcp",
      "headers": { "Authorization": "Bearer ld_live_YOUR_KEY" }
    }
  }
}
```

**Other clients:** URL `https://mcp.locationdrive.com/mcp` with header
`Authorization: Bearer ld_live_YOUR_KEY`.

## Try it

Ask your AI client things like:

- *"What data coverage does Location Drive have for Anguilla?"*
- *"Find restaurants within 1 km of 18.2170, -63.0578."*
- *"Which building sits at 18.2168, -63.0581, and what's its accuracy grade?"*
- *"How many Starbucks locations are there worldwide, by country?"*
- *"Compare room rates for this hotel across booking sites."*
- *"How have this restaurant's reviews changed over the past few years?"*
- *"Which cafés within 1.5 km of 30.0289, 31.4910 have reviews mentioning racism or hijab (عنصرية، حجاب)?"*

## Notes

- Every plan receives the full field set and every endpoint (API v8): there
  is no plan gating on fields or tools. Plans differ by monthly API-call
  allowance, results per request, search radius and rate limit.
- Review text exists in the data — `reviews` (current crawl),
  `historical_reviews` (earlier crawls), and `get_review_history` (both merged,
  de-duplicated). When a requested field comes back missing, `get_place_details`
  returns a `data_note`: nothing was stripped, that place has no data for it.
  `get_place_context` carries `review_sentiments` keyword counts, not review text.
- Review data is per place: there is no city- or country-wide search over
  review content. For "which places near a point have reviews mentioning X" use
  `scan_reviews` — it runs the nearby search, reads up to 40 places' review
  histories (one API request each; `ld_test_` keys are capped at 10 places),
  and returns only the matching snippets.
  Keyword matching is a coarse filter over user-submitted text: read the
  snippets before drawing conclusions.
- Usage is counted in API calls, per place returned (since 2026-09-18): a list
  tool costs one API call per result (its `limit`), single-place and summary
  tools cost 1, and `scan_reviews` costs the nearby search plus 1 per scanned
  place. Every tool result includes `api_calls_counted`. Plan allowances: Free
  5,000 / Starter 500,000 / Business 5,000,000 API calls per month — see
  https://locationdrive.com/docs#api-call-counting.
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
