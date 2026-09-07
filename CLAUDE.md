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

Both modes use **the customer's own API key**, so plan gating, quotas, and
usage metering apply exactly as for direct REST calls. This is a deliberate
design decision — the server adds no auth, no caching, and no rate limiting of
its own; `api.locationdrive.com` is the enforcement point.

Related repo: the marketing site + docs live in the `LocationDrive` website
repo (may move into this org). Its `/docs#mcp` section, homepage MCP callout,
and footer link must stay in sync with this repo (see "Sync points").

## Layout

```
src/version.ts     VERSION + SERVER_NAME ("locationdrive").
                   VERSION must ALWAYS equal package.json "version" — bump both.
src/api.ts         ld() fetch client (Bearer auth, User-Agent locationdrive-mcp/<ver>),
                   SLIM_FIELDS (compact default field list for list results),
                   out() → single-line JSON.stringify content block,
                   fail() → isError:true with plan-aware messages (see Error mapping).
src/tools.ts       registerTools(server, getKey) — all 10 tools; SERVER_INSTRUCTIONS
                   string (injected as server instructions at construction).
src/stdio.ts       Local entrypoint: reads LOCATIONDRIVE_API_KEY (exits with a clear
                   message if missing), StdioServerTransport.
api/mcp.ts         Vercel entrypoint: CORS headers, OPTIONS preflight, extracts the
                   Bearer token (401 JSON if absent), builds a NEW McpServer +
                   StreamableHTTPServerTransport per request with
                   sessionIdGenerator: undefined (STATELESS — required, Vercel
                   functions share no memory), transport.handleRequest(req, res, req.body).
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
  fetched per-ID via `get_place_details`. Keep responses small.
- Only **documented** API endpoints (the 24 in the website docs). Undocumented
  paths (e.g. `/v1/autocomplete`) were removed once already — don't reintroduce.
- No secrets in the repo, ever: keys appear only as `ld_live_YOUR_KEY`
  placeholders. The one real key pasted in an early smoke test was ordered rotated.
- No references to `ahmedmaher1` anywhere (repo was transferred from
  `ahmedmaher1/locationdrive-mcp` → `Locationdrive/mcp`; all metadata, links,
  and pages point at the org).

## The 10 tools

| Tool | Backing endpoint | Plan |
|---|---|---|
| `search_places` | `GET /v1/places/search` | Free+ |
| `find_nearby` | `GET /v1/places/nearby` (adds `distance_m`) | Free+ |
| `get_place_details` | `GET /v1/places/{id}` (`fields` passthrough, `*` allowed) | Free+ (premium fields Business+) |
| `get_place_context` | `GET /v1/ai/context/{id}` (LLM-ready summary) | Free+ |
| `get_review_history` | `GET /v1/places/{id}/reviews/summary` (merged current + historical reviews, de-duplicated, `reviews_meta`, sentiments) | **Business+** |
| `get_hotel_rates` | `GET /v1/places/{id}?fields=name,hotel_class,hotel_price,hotel_details,check_in_time,check_out_time` (adds `rates_note` when `hotel_details` is null) | **Business+** (hotel fields stripped below) |
| `get_building_polygon` | `GET /v1/polygons/{id}` (`format` geojson/wkt/both) | **Starter+** |
| `find_building_at_point` | `GET /v1/polygons/contains` | **Starter+** |
| `brand_footprint` | `GET /v1/brands/{brand}/summary` | Free+ |
| `data_coverage` | `/v1/countries` (no arg) or `/v1/polygons/coverage?country=XX` | Free+ |

`SERVER_INSTRUCTIONS` (src/tools.ts) tells clients to call `data_coverage`
first when coverage is uncertain and explains plan gating + `ld_test_` keys.

## API truth

- Base `https://api.locationdrive.com/v1`; auth `Authorization: Bearer` on
  everything except `GET /health`. `ld_test_` keys → synthetic data, no quota.
- Plans: Free / Starter ($99/mo) / Business ($399/mo) / Enterprise.
  Gating: `/v1/polygons/*` Starter+; premium field packs (EV charging, fuel,
  menus, hotel rates, review intelligence) and `/v1/places/{id}/reviews/summary`
  Business+. Fields above plan are silently stripped, not errors.
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
  - 403 / `FORBIDDEN` / `PLAN_REQUIRED` → "requires a higher Location Drive
    plan … see https://locationdrive.com/pricing"
  - 429 / `RATE_LIMITED` / `QUOTA_EXCEEDED` → "rate limit or monthly quota
    exceeded for this API key"
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
