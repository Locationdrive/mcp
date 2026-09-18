# CLAUDE.md — Location Drive MCP server

Guidance for Claude Code sessions working in this repository
(**`Locationdrive/mcp`** on GitHub — note the org owner, not a personal
account). Read fully before editing; it encodes decisions already made.

## What this repo is

The official **Model Context Protocol server** for the Location Drive API
(global POI database: 350M+ places, graded A–E building polygons, brand
intelligence, premium data packs). One codebase, two deployment modes:

1. **Local stdio** — published to npm as **`@locationdrive/mcp`**
   (bin: `locationdrive-mcp` → `dist/stdio.js`), run via
   `npx -y @locationdrive/mcp` with env `LOCATIONDRIVE_API_KEY`.
2. **Hosted HTTP** — Vercel serverless function at
   **`https://mcp.locationdrive.com/mcp`** (Streamable HTTP, stateless),
   authenticated per-request with `Authorization: Bearer ld_live_...`.

Both modes use **the customer's own API key**, so quotas and usage
metering apply exactly as for direct REST calls. This is a deliberate
design decision — the server adds no auth, no caching, and no rate limiting of
its own; `api.locationdrive.com` is the enforcement point.

Related repo: the marketing site + docs live in the `LocationDrive` website
repo (may move into this org). Its `/docs#mcp` section, homepage MCP callout,
and footer link must stay in sync with this repo (see "Sync points").

## Layout

```
src/version.ts     VERSION + SERVER_NAME ("locationdrive").
                   VERSION must ALWAYS equal package.json "version" — bump both.
src/api.ts         ld() fetch client (Bearer auth, User-Agent locationdrive-mcp/<ver>,
                   default 20 s timeout — LOCATIONDRIVE_TIMEOUT_MS — surfacing as LDError
                   504 UPSTREAM_TIMEOUT; raw non-JSON upstream bodies are never relayed),
                   SLIM_FIELDS (compact default field list for list results),
                   out() → single-line JSON.stringify content block,
                   fail() → isError:true with plan-aware messages (see Error mapping).
src/tools.ts       registerTools(server, getKey) — all 11 tools; SERVER_INSTRUCTIONS
                   string (injected as server instructions at construction).
src/scan.ts        scanReviews(): the one fan-out tool — nearby search, then
                   /reviews/summary per place (≤40, ≤10 for ld_test_ keys; concurrency 6,
                   45 s soft deadline checked per place AND per review, 15 s per request,
                   20k chars per review), keyword matching with Arabic-aware normalization
                   (tashkeel stripped, alef variants, ى→ي, ة→ه), snippets cut from the
                   original text. Aborts the whole scan on 401/403/429.
src/stdio.ts       Local entrypoint: reads LOCATIONDRIVE_API_KEY (exits with a clear
                   message if missing), StdioServerTransport.
api/mcp.ts         Vercel entrypoint: CORS headers, OPTIONS preflight, extracts the
                   Bearer token (401 JSON if absent), builds a NEW McpServer +
                   StreamableHTTPServerTransport per request with
                   sessionIdGenerator: undefined (STATELESS — required, Vercel
                   functions share no memory), transport.handleRequest(req, res, req.body) —
                   all inside try/catch → generic JSON-RPC -32603 on failure, nothing leaks.
public/index.html  Landing page served at / — self-contained static HTML (inline CSS/JS,
                   no external assets): quickstart configs, tool grid, copy buttons.
vercel.json        functions: api/mcp.ts (maxDuration 60) — declared EXPLICITLY so a
                   deploy without the function fails loudly; rewrite /mcp → /api/mcp.
scripts/smoke.mjs  Live smoke test of every documented endpoint the tools depend on:
                   LOCATIONDRIVE_API_KEY=ld_live_x node scripts/smoke.mjs
tsconfig.json      Emits dist/ from src/ (ES2022, NodeNext ESM).
tsconfig.api.json  noEmit typecheck covering api/** + src/**.
```

## Conventions (do not drift)

- **SDK**: `@modelcontextprotocol/sdk` ^1.12. Register tools with
  `server.registerTool(name, { title, description, inputSchema, annotations }, cb)`
  — never the deprecated `server.tool()`. Zod **v3** for schemas (SDK-compatible;
  do not upgrade to zod 4 without verifying SDK support).
- Every tool carries `annotations: READ_ONLY` = `{ readOnlyHint: true,
  openWorldHint: true }`. This server is read-only by design — if a write tool
  is ever proposed, that's an owner decision, not a code change.
- ESM throughout (`"type": "module"`, NodeNext): **relative imports need the
  `.js` suffix** (`from "./api.js"`), Node >= 18.
- Tool results go through `out()` (compact JSON, no pretty-printing — token
  economy for the calling model) and errors through `fail()` (returns
  `isError: true`, never throws to the transport).
- List tools default to `SLIM_FIELDS` and cap `limit` at 20 — full records are
  fetched per-ID via `get_place_details`. Keep responses small. `scan_reviews`
  is the one deliberate exception: it fans out to ≤40 review fetches per call
  and returns only matching snippets — keep it bounded (limit ≤40, concurrency
  6, soft deadline inside Vercel's 60 s).
- Hardening baseline (v1.0.7, from the Sept 2026 security audit): every upstream
  call has a timeout; raw non-JSON upstream bodies never reach the model;
  `scan_reviews` is bounded per review and capped at 10 places for `ld_test_`
  keys; `api/mcp.ts` never leaks errors. Still open for the owner: operator-side
  rate limiting of `/api/mcp` (audit finding H2) is a Vercel Firewall rule, not
  code — in code the caller's plan limits remain the only backstop.
- Only **documented** API endpoints (the 24 in the website docs). Undocumented
  paths (e.g. `/v1/autocomplete`) were removed once already — don't reintroduce.
- No secrets in the repo, ever: keys appear only as `ld_live_YOUR_KEY`
  placeholders. The one real key pasted in an early smoke test was ordered rotated.
- No references to `ahmedmaher1` anywhere (repo was transferred from
  `ahmedmaher1/locationdrive-mcp` → `Locationdrive/mcp`; all metadata, links,
  and pages point at the org).

## The 11 tools

| Tool | Backing endpoint | Plan |
|---|---|---|
| `search_places` | `GET /v1/places/search` | All plans |
| `find_nearby` | `GET /v1/places/nearby` (adds `distance_m`) | All plans |
| `get_place_details` | `GET /v1/places/{id}` (`fields` passthrough, `*` allowed; adds `data_note` when explicitly requested fields come back missing — no data for that place, nothing is plan-stripped) | All plans |
| `get_place_context` | `GET /v1/ai/context/{id}` (LLM-ready summary) | All plans |
| `get_review_history` | `GET /v1/places/{id}/reviews/summary` (merged current + historical reviews, de-duplicated, `reviews_meta`, sentiments) | All plans |
| `scan_reviews` | `GET /v1/places/nearby` (≤40, ≤10 for ld_test_ keys; minimal fields) + `GET /v1/places/{id}/reviews/summary` per place; returns only matching review snippets per place + `no_match_places` | All plans |
| `get_hotel_rates` | `GET /v1/places/{id}?fields=name,hotel_class,hotel_price,hotel_details,check_in_time,check_out_time` (adds `rates_note` when `hotel_details` is null) | All plans |
| `get_building_polygon` | `GET /v1/polygons/{id}` (`format` geojson/wkt/both) | All plans |
| `find_building_at_point` | `GET /v1/polygons/contains` | All plans |
| `brand_footprint` | `GET /v1/brands/{brand}/summary` | All plans |
| `data_coverage` | `/v1/countries` (no arg) or `/v1/polygons/coverage?country=XX` | All plans |

`SERVER_INSTRUCTIONS` (src/tools.ts) tells clients to call `data_coverage`
first when coverage is uncertain, states that every plan gets every field and
tool (no plan gating) + `ld_test_` keys, states that review text exists in the
data (missing fields = no data for that place, never "no review data"), and that review data is per place (`scan_reviews` for a neighborhood; no city- or
country-wide review search).

## API truth

- Base `https://api.locationdrive.com/v1`; auth `Authorization: Bearer` on
  everything except `GET /health`. `ld_test_` keys → synthetic data, no quota.
- Plans: Free ($0, 5,000 API calls/mo since 2026-09-18) / Starter ($99/mo, 500k) /
  Business ($399/mo, 5M) / Enterprise (custom, unlimited).
  **No plan gating (API v8, confirmed from the deployed POI Lambda on 2026-09-18):**
  every plan receives all fields and all endpoints; plans differ by monthly API
  calls, results per request (20/50/100/500), radius (5/25/100/500 km), rate limit
  (2/10/50/200 rps) and batch size. `plan_note` became `data_note` in v1.0.9.
- **Usage counting (2026-09-18, authorizer v3.4 / POI Lambda v9):** API calls
  are counted per place returned — a list request costs the places it returns
  (its `limit`; the API's default is 20), single-place, summary and autocomplete
  requests cost 1, 429 `QUOTA_EXCEEDED` refusals are not counted, and every JSON
  response carries `api_calls_counted` (header `X-API-Calls-Counted`). Plan
  allowances Free 5k (since 2026-09-18) / Starter 500k / Business 5M per month; max
  results per request Free 20 / Starter 50 / Business 100 / Enterprise 500.
  Tools pass bodies through, so single-call tools surface `api_calls_counted`
  as-is; `scan_reviews` sums it (`countedCalls()` in api.ts) and the
  ld_test_ / list-tool defaults (5 / 8) keep agent usage small. v1.0.8 added
  the counting notes to SERVER_INSTRUCTIONS and the list tools' descriptions.
- There is **no cross-place search over review content** — review text
  (`reviews`, `historical_reviews`, `reviews/summary`) is per place. The
  "which places in <country> have reviews mentioning X" question is out of reach
  for the MCP (one request per place, millions of places) — `scan_reviews` handles
  the neighborhood version (≤40 nearest places); country scale needs a backend
  review-search or topic-filter endpoint (roadmap: semantic search). A Sept 2026
  incident: an assistant on a sub-Business key told a user Location Drive "has
  no review text" — that's why the missing-field note (`data_note` since v1.0.9,
  formerly `plan_note`) and the instructions exist.
- Premium field shapes (backend, Aug 2026): `menu_items`
  `{sections:[{name, items:[{name, description, price:{display, amount, currency}}]}]}` ·
  `hotel_details` `{offers:[{site, url, price:{display, amount, currency}}]}`, with
  `hotel_price` a headline string ("$314") and `hotel_class` like "4 stars" ·
  `ev_connectors` `[{type, power_kw, speed, plug_count, port_ids}]` plus
  `ev_connector_types`, `ev_network`, `ev_max_power_kw`, `ev_plug_count`,
  `ev_stall_count`, `ev_speed` · `historical_reviews`
  `{reviews:[{rating, reviewer, date, text}]}` (earlier crawl cycles, may overlap
  `reviews`) · `reviews/summary` returns merged de-duplicated `reviews` (newest
  first, `source: "current"|"historical"`) + `reviews_meta` {unique_total,
  from_current, from_historical, duplicates_removed, oldest, newest} + rating,
  rating_distribution, sentiments.
- Error mapping in `fail()` — keep these exact semantics:
  - 403 / `FORBIDDEN` / `PLAN_REQUIRED` → "access denied for this API key
    (inactive, revoked, or IP allowlist)" — the API has no plan gating since v8
  - 429 / `RATE_LIMITED` / `QUOTA_EXCEEDED` → "rate limit or monthly API-call
    allowance exceeded for this API key"
  - 401 → invalid/missing key message.
- Live-data caveat: the production dataset is still ramping (Anguilla-only as
  of Aug 2026) — e.g. `brand_footprint("Starbucks")` legitimately returns 0.
  That is data coverage, not a bug.

## Build, test, release

```bash
npm run build      # tsc (emit dist/) + tsc -p tsconfig.api.json (typecheck api/)
npm run inspect    # MCP Inspector against the local build
LOCATIONDRIVE_API_KEY=ld_live_x node scripts/smoke.mjs   # live endpoint smoke
```

Useful harness: an in-memory test client
(`InMemoryTransport.createLinkedPair()` + `Client` from the SDK) lists tools /
calls them without a network — good for verifying registrations, annotations,
instructions, and the `isError` path.

**Release checklist (in order):**
1. Bump `package.json` "version" **and** `src/version.ts` `VERSION` (must match).
2. `npm run build` passes.
3. Update sync points if tools/config changed (see below).
4. Commit + push `main` → Vercel auto-deploys the hosted endpoint.
5. Verify hosted: `POST https://mcp.locationdrive.com/mcp` with no auth → 401
   JSON; then an `initialize` JSON-RPC call with a real key → serverInfo
   `locationdrive` at the new version.
6. `npm publish --access public` (owner runs it — publish requires the
   npm account's 2FA). `prepublishOnly` rebuilds automatically.
7. Sanity: `npx -y @locationdrive/mcp` starts and reports the new version;
   npm page shows the org repo link.

## Vercel deployment (hard-won facts)

- Project settings: **Root Directory EMPTY** (repo root), Output Directory
  `public`, Git connected to `Locationdrive/mcp`, domain
  `mcp.locationdrive.com` attached to **this** project (the launch 405 was the
  domain attached to the wrong project — symptom: `405` + `Content-Disposition:
  … filename="index.html"` means only the static layer answered).
- `vercel.json` keeps the explicit `functions` block so a build that would drop
  the function fails loudly instead of shipping static-only. Keep it.
- DNS lives at **Hostinger**: `CNAME mcp → cname.vercel-dns.com`. Nameservers
  stay at Hostinger — never advise moving them.
- `public/index.html` must stay fully self-contained (inline CSS/JS, data-URI
  favicon, no CDNs).

## Sync points — update together

When tools, endpoints, or connection config change, update **all** of:
1. `src/tools.ts` (the truth),
2. `README.md` (tool table + setup blocks — README ships in the npm package
   and is the npm page),
3. `public/index.html` (landing page tool grid + quickstart snippets),
4. website repo `/docs#mcp` section (`DocMcp` in `src/pages/DocsPage.jsx`),
   homepage callout (`RestGraphQLAPI.jsx`), footer link (`Footer.jsx`),
5. both `llms.txt` files — `public/llms.txt` here (mcp.locationdrive.com/llms.txt)
   and the website's `public/llms.txt` — each lists every tool and the count.

## Session rules

- Work on this codebase happens in Claude sessions **started on
  `Locationdrive/mcp`** — a session started on a differently-owned repo cannot
  push here (same-owner `add_repo` restriction), which previously forced
  staging-branch handoffs. Don't recreate that workaround.
- The owner merges and publishes; never publish to npm or add a custom domain
  without being asked.
- `.claude/settings.json` registers the ECC plugin marketplace (`affaan-m/ECC`)
  and enables `ecc@ecc` for every session on this repo — web, desktop, and CLI
  (owner decision, Sept 2026). ECC ships hooks on session/tool events (e.g. a
  fact-forcing gate before the first Bash call); tune or disable them per
  machine with `/plugin configure ecc@ecc` (`hooks_enabled`, `hook_profile`
  minimal/standard/strict). Remove the file to drop the plugin.
