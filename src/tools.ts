import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ld, out, fail, SLIM_FIELDS } from "./api.js";
import { scanReviews } from "./scan.js";

/** Every Location Drive tool is a read-only query against an external API. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Field selection for get_hotel_rates — the Hospitality pack plus identity. */
const HOTEL_FIELDS = "name,hotel_class,hotel_price,hotel_details,check_in_time,check_out_time";

/** Premium-pack fields — available on every plan since API v8; listed so a missing one can be explained. */
const PREMIUM_FIELDS = new Set([
  "menu_items", "hotel_details", "hotel_price", "hotel_class",
  "ev_connectors", "ev_connector_types", "ev_network", "ev_max_power_kw", "ev_plug_count", "ev_stall_count", "ev_speed",
  "fuel_types", "fuel_price", "reviews", "historical_reviews", "review_sentiments",
]);

/**
 * When explicitly requested premium fields come back missing, say what that means.
 * Every plan receives the full field set, so a missing field is a gap in the data
 * for this place (no menu, rates, connectors or review text captured) — never plan
 * gating. Without this a model concludes "Location Drive has no review text".
 */
function withDataNote(body: unknown, fields?: string) {
  if (!fields || fields.trim() === "*") return body;
  const requested = fields.split(",").map((f) => f.trim()).filter((f) => PREMIUM_FIELDS.has(f));
  if (requested.length === 0) return body;
  const record = (body as any)?.data ?? body;
  if (!record || typeof record !== "object") return body;
  const missing = requested.filter((f) => !(f in record));
  if (missing.length === 0) return body;
  return {
    ...(body as object),
    data_note:
      `Requested field(s) not returned: ${missing.join(", ")}. Every plan receives all fields, so nothing was stripped — ` +
      "no data is recorded for these fields on this place (e.g. no menu, rates, EV connectors or review text captured). " +
      "Other places may have them.",
  };
}

/** Server-level usage guidance injected into client context. */
export const SERVER_INSTRUCTIONS =
  "Location Drive is a global POI database (350M+ places, graded building polygons). " +
  "Call data_coverage first when unsure whether a country/region is covered. " +
  "Every plan receives the full field set and every endpoint — there is no plan gating on fields or tools; plans differ " +
  "only by monthly API-call allowance, results per request, search radius and rate limit. " +
  "Review text exists in the data: reviews (current crawl), historical_reviews (earlier crawls), and get_review_history " +
  "(both merged, de-duplicated). If those fields come back missing for a place, no review text was captured for that " +
  "place — say that, never that Location Drive has no review data. get_place_context returns a summary plus " +
  "review_sentiments keyword counts, not review text. " +
  "Review data is per place: there is no city- or country-wide search over review content. For 'which places near a point " +
  "have reviews mentioning X' use scan_reviews (scans up to 40 nearest places, one request each, returns matching snippets); " +
  "for one place use get_review_history. " +
  "Usage is counted per place returned: search_places and find_nearby cost one API call per result (their limit; the API's " +
  "own default is 20), single-place and summary tools cost 1, scan_reviews costs the nearby search plus 1 per scanned place, " +
  "and every result includes api_calls_counted — keep limit as small as the question allows. " +
  "ld_test_ keys return synthetic data without using quota.";

/**
 * Registers all Location Drive tools on an MCP server instance.
 * `getKey` resolves the customer's own API key (env var locally,
 * Authorization header remotely) — so quotas and usage metering apply
 * exactly as for direct API calls.
 */
export function registerTools(server: McpServer, getKey: () => string) {
  server.registerTool(
    "search_places",
    {
      title: "Search places",
      description:
        "Search the global Location Drive POI database by name or keyword. " +
        "Returns matching businesses/places with address, coordinates, rating, hours, and contact info. " +
        "Use for questions like 'find X in <city/country>' or when you have a business name to look up. " +
        "Usage: counted per place returned — limit sets the cost (default 5 here; the API's default is 20); the result includes api_calls_counted.",
      inputSchema: {
        query: z.string().min(2).describe("Name or keyword, e.g. 'Marriott' or 'coffee'"),
        country: z.string().length(2).optional().describe("ISO-2 country filter, e.g. 'US'"),
        category: z.string().optional().describe("Category filter, e.g. 'Restaurant'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5). Each result counts as one API call."),
      },
      annotations: READ_ONLY,
    },
    async ({ query, country, category, limit }) => {
      try {
        return out(await ld(getKey(), "/v1/places/search", {
          q: query, country, category, limit: limit ?? 5, fields: SLIM_FIELDS,
        }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "find_nearby",
    {
      title: "Find nearby places",
      description:
        "Find places around a coordinate, sorted by distance (adds distance_m to each result). " +
        "Use for 'what is near <lat,lng>', 'restaurants around this point', or local-area exploration. " +
        "Usage: counted per place returned — limit sets the cost (default 8 here; the API's default is 20); the result includes api_calls_counted.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (WGS84)"),
        longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (WGS84)"),
        radius_m: z.number().int().min(50).max(100000).optional().describe("Search radius in meters (default 1000)"),
        category: z.string().optional().describe("Category filter, e.g. 'Gas station'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8). Each result counts as one API call."),
      },
      annotations: READ_ONLY,
    },
    async ({ latitude, longitude, radius_m, category, limit }) => {
      try {
        return out(await ld(getKey(), "/v1/places/nearby", {
          lat: latitude, lng: longitude, radius: radius_m ?? 1000,
          category, limit: limit ?? 8, fields: SLIM_FIELDS + ",distance_m",
        }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_place_details",
    {
      title: "Get place details",
      description:
        "Full record for one place by its Location Drive ID (from a previous search). " +
        "Optionally request specific fields — including the premium packs, available on every plan: " +
        "menu_items (full menu: sections → items with structured prices), " +
        "hotel_details (room-rate offers from multiple booking sites, with links), hotel_price, hotel_class, " +
        "ev_connectors (per-connector type, power_kw, speed, plug_count) plus ev_connector_types, ev_network, " +
        "ev_max_power_kw, ev_plug_count, ev_stall_count, ev_speed, fuel_price, " +
        "reviews (current-cycle review text), historical_reviews (review text from earlier crawl cycles), review_sentiments. " +
        "Ask for fields=reviews,historical_reviews to read what reviewers actually wrote, or use get_review_history for the " +
        "merged, de-duplicated history. If requested fields are missing, the response carries a data_note: every plan receives " +
        "all fields, so the place simply has no data recorded for them. Counts as 1 API call.",
      inputSchema: {
        place_id: z.string().describe("Location Drive place ID, e.g. 'ld_3GB7KWu3lxlI'"),
        fields: z.string().optional().describe("Comma-separated field list, or '*' for all plan-eligible fields"),
      },
      annotations: READ_ONLY,
    },
    async ({ place_id, fields }) => {
      try {
        return out(withDataNote(await ld(getKey(), `/v1/places/${encodeURIComponent(place_id)}`, { fields }), fields));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_place_context",
    {
      title: "Get place context (LLM-ready)",
      description:
        "LLM-ready context for one place: a natural-language summary plus structured data, including " +
        "review_sentiments (topic keyword counts, e.g. pizza: 21, service: 14) — NOT review text. " +
        "Prefer this to describe or reason about a place overall. For what reviewers actually wrote " +
        "(complaints, incidents, specific experiences) use get_review_history, or get_place_details with " +
        "fields=reviews,historical_reviews.",
      inputSchema: { place_id: z.string().describe("Location Drive place ID") },
      annotations: READ_ONLY,
    },
    async ({ place_id }) => {
      try {
        return out(await ld(getKey(), `/v1/ai/context/${encodeURIComponent(place_id)}`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_review_history",
    {
      title: "Get review history",
      description:
        "Merged multi-year review history for one place, duplicates removed: current and historical reviews " +
        "newest first, each tagged source 'current' or 'historical', with reviews_meta counts (unique_total, " +
        "from_current, from_historical, duplicates_removed, oldest, newest), overall rating, rating distribution, " +
        "and a sentiment summary. This is the tool for what reviewers said about ONE place — complaints, incidents, " +
        "recurring themes, reputation trends. For 'which places near a point have reviews mentioning X' use scan_reviews " +
        "instead; there is no city- or country-wide review search. Available on every plan; counts as 1 API call.",
      inputSchema: { place_id: z.string().describe("Location Drive place ID") },
      annotations: READ_ONLY,
    },
    async ({ place_id }) => {
      try {
        return out(await ld(getKey(), `/v1/places/${encodeURIComponent(place_id)}/reviews/summary`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "scan_reviews",
    {
      title: "Scan nearby reviews for keywords",
      description:
        "Scan the review text of up to 40 places near a point for keywords and return the matching review snippets " +
        "per place. Use for 'which cafés/restaurants near X have reviews mentioning Y' — complaints, incidents, or themes " +
        "such as discrimination, harassment, hygiene, noise. Give keywords in every relevant language and spelling " +
        "(e.g. Arabic and English); matching is case-, diacritic- and alef-variant-insensitive substring matching. " +
        "Usage: the nearby search is counted per place returned (≤ limit) plus 1 API call per scanned place — up to 2 × limit API calls (≤ 80); " +
        "the result reports api_calls_counted (ld_test_ keys are capped at 10 places). " +
        "Neighborhood scale only — " +
        "there is no city- or country-wide review search. Available on every plan. Snippets are user-submitted " +
        "opinions: read them before drawing conclusions and quote reviewers rather than labeling businesses.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (WGS84)"),
        longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (WGS84)"),
        keywords: z.array(z.string().min(2).max(200)).min(1).max(30)
          .describe("Terms to look for in review text, any language, e.g. ['racist','عنصرية','hijab','حجاب','محجبة']"),
        radius_m: z.number().int().min(50).max(100000).optional().describe("Search radius in meters (default 1500)"),
        category: z.string().optional().describe("Category filter for the nearby search, e.g. 'Restaurant' or 'Cafe'"),
        limit: z.number().int().min(1).max(40).optional().describe("Max places to scan, nearest first (default 20, max 40)"),
        max_snippets_per_place: z.number().int().min(1).max(10).optional().describe("Max matching snippets returned per place (default 3)"),
      },
      annotations: READ_ONLY,
    },
    async ({ latitude, longitude, keywords, radius_m, category, limit, max_snippets_per_place }) => {
      try {
        return out(await scanReviews(getKey(), {
          latitude, longitude, keywords, radius_m: radius_m ?? 1500, category,
          limit: limit ?? 20, max_snippets_per_place: max_snippets_per_place ?? 3,
        }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_hotel_rates",
    {
      title: "Get hotel rates",
      description:
        "Compare room rates across booking sites for one hotel: headline nightly rate (hotel_price), star class, " +
        "per-site offers with prices and links (hotel_details.offers), and check-in/check-out times. " +
        "Available on every plan; when a hotel has no listed rates the response carries a rates_note. Counts as 1 API call.",
      inputSchema: { place_id: z.string().describe("Location Drive place ID of the hotel") },
      annotations: READ_ONLY,
    },
    async ({ place_id }) => {
      try {
        const body = await ld(getKey(), `/v1/places/${encodeURIComponent(place_id)}`, { fields: HOTEL_FIELDS });
        const record = (body as any)?.data ?? body;
        if (record && typeof record === "object" && record.hotel_details == null) {
          return out({
            ...(body as object),
            rates_note:
              "No room-rate data returned: no rates are listed for this place. Every plan receives the hotel fields, so nothing was stripped.",
          });
        }
        return out(body);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_building_polygon",
    {
      title: "Get building polygon",
      description:
        "Building footprint polygon for a place, with the A–E accuracy grade and area in m². " +
        "Returns GeoJSON ready for maps. Available on every plan; counts as 1 API call.",
      inputSchema: {
        place_id: z.string().describe("Location Drive place ID"),
        format: z.enum(["geojson", "wkt", "both"]).optional().describe("Geometry format (default geojson)"),
      },
      annotations: READ_ONLY,
    },
    async ({ place_id, format }) => {
      try {
        return out(await ld(getKey(), `/v1/polygons/${encodeURIComponent(place_id)}`, { format }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "find_building_at_point",
    {
      title: "Find building at point",
      description:
        "Reverse building lookup: given a coordinate, returns the building footprint that contains it " +
        "and the business(es) inside. Location Drive's signature capability. Available on every plan; counts as 1 API call.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (WGS84)"),
        longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (WGS84)"),
      },
      annotations: READ_ONLY,
    },
    async ({ latitude, longitude }) => {
      try {
        return out(await ld(getKey(), "/v1/polygons/contains", { lat: latitude, lng: longitude }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brand_footprint",
    {
      title: "Brand footprint summary",
      description:
        "Brand intelligence summary: store counts by country, open-now count, polygon coverage, " +
        "and average rating for a retail/restaurant/hotel brand. " +
        "Use for 'how many <brand> locations are there', competitor analysis, or market sizing. Counts as 1 API call (summary endpoint).",
      inputSchema: {
        brand: z.string().min(2).describe("Brand name, e.g. 'Starbucks'"),
      },
      annotations: READ_ONLY,
    },
    async ({ brand }) => {
      try {
        return out(await ld(getKey(), `/v1/brands/${encodeURIComponent(brand)}/summary`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "data_coverage",
    {
      title: "Data coverage",
      description:
        "What data Location Drive has: per-country POI counts, and for a specific country the " +
        "building-polygon coverage percentage with grade distribution. " +
        "Call this first when unsure whether a region is covered. Counts as 1 API call.",
      inputSchema: {
        country: z.string().length(2).optional().describe("ISO-2 code for detailed polygon coverage; omit for the global country list"),
      },
      annotations: READ_ONLY,
    },
    async ({ country }) => {
      try {
        return country
          ? out(await ld(getKey(), "/v1/polygons/coverage", { country }))
          : out(await ld(getKey(), "/v1/countries"));
      } catch (e) { return fail(e); }
    },
  );
}
