# Location Drive MCP Server

Query the Location Drive location-data platform from Claude, Cursor, or any
MCP-compatible AI client: global POI search, graded building-footprint
polygons, brand intelligence, and premium data packs (EV charging, fuel
prices, full menus, multi-site hotel rates, multi-year review history) — using
your own Location Drive API key, so your plan, quotas, and usage dashboard
apply exactly as with direct API calls.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `search_places` | Search the global POI database by name/keyword — ranked by prominence for general terms, by similarity for specific names | `limit` per page (default 20); `max_results` auto-pages and sums the cost |
| `find_nearby` | Distance-sorted places around a coordinate (adds `distance_m`) | `limit` per page (default 20); `max_results` auto-pages |
| `brand_locations` | Every location of a brand — one country or global — with the total | `limit` per page (default 20); `max_results` auto-pages |
| `get_place_details` | Full record by ID; request any of the 97 fields via `fields` — premium packs (menus, hotel rates, EV connectors, fuel, review text) included on every plan; `data_note` when a requested field has no data for that place | 1 |
| `get_place_context` | LLM-ready summary + structured data (sentiment keywords, not review text) for one place | 1 |
| `get_review_history` | Merged multi-year review text history, duplicates removed, plus sentiment summary | 1 |
| `scan_reviews` | Keyword scan of review text across up to 40 places near a point — matching snippets per place; neighborhood scale | the nearby search (its `limit`) + 1 per scanned place, reported as `api_calls_counted` |
| `get_hotel_rates` | Compare room rates across booking sites for one hotel | 1 |
| `get_building_polygon` | GeoJSON footprint with A–E accuracy grade | 1 |
| `find_building_at_point` | Reverse lookup: which building contains this coordinate | 1 |
| `brand_footprint` | Store counts, open-now, coverage, avg rating for a brand | 1 (summary) |
| `data_coverage` | Per-country POI counts and polygon coverage stats | 1 |

All plans receive all 97 fields. Usage is counted per place returned: list
tools cost their limit (default 20); single-place and summary tools cost 1.
Free keys: 5,000 API calls/month, 20 results per call. A list request is
charged its `limit` whatever it returns, so the list tools never send more
than 20 unless you set `limit`; `max_results` (≤ 1,000) pages automatically
and returns the summed `api_calls_counted`.

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

- *"What data coverage does Location Drive have for Japan?"*
- *"Find restaurants within 1 km of 18.2170, -63.0578."*
- *"Which building sits at 18.2168, -63.0581, and what's its accuracy grade?"*
- *"How many Starbucks locations are there worldwide, by country?"*
- *"List the Starbucks stores in the US."*
- *"Compare room rates for this hotel across booking sites."*
- *"How have this restaurant's reviews changed over the past few years?"*
- *"Which cafés within 1.5 km of 30.0289, 31.4910 have reviews mentioning racism or hijab (عنصرية، حجاب)?"*

## Notes

- Every plan receives all 97 fields and every endpoint (API v8): there is no
  plan gating on fields or tools. Plans differ by monthly API-call allowance
  (Free 5,000 / Starter 500,000 / Business 5,000,000), results per request
  (20 / 50 / 100 / 500) and search radius; requests per second are fair-use
  guidance, not a per-key limiter.
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
- Usage is counted in API calls from the request itself: a list tool is charged
  its `limit` per page (default 20, capped at the plan's results per request)
  whatever the page returns, single-place and summary tools cost 1, and
  `scan_reviews` costs the nearby search plus 1 per scanned place. Every tool
  result includes `api_calls_counted` (from the response body, or the
  `X-API-Calls-Counted` header when the body lacks it) — see
  https://locationdrive.com/docs#api-call-counting.
- A `429 QUOTA_EXCEEDED` means the key's monthly allowance is exhausted (the
  refused request is not counted); it resets on the 1st at 00:00 UTC.
- `ld_test_` keys work and return synthetic data without counting against
  quotas — useful for trying the integration.
- The hosted endpoint adds no rate limiting of its own: your API key's
  monthly allowance (enforced by api.locationdrive.com) is the backstop, and
  unauthenticated requests are rejected immediately. Upstream calls time out
  after 10 s (`LOCATIONDRIVE_TIMEOUT_MS` overrides).

## Development

```bash
npm install
npm run build      # compiles src/ and typechecks api/
npm run inspect   # MCP Inspector against the local build
LOCATIONDRIVE_API_KEY=ld_live_x node scripts/smoke.mjs   # live API smoke test
```

MIT © Location Drive, LLC
