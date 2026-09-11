import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ld, out, fail, SLIM_FIELDS } from "./api.js";
import { scanReviews } from "./scan.js";

/** Every Location Drive tool is a read-only query against an external API. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Field selection for get_hotel_rates — the Hospitality pack plus identity. */
const HOTEL_FIELDS = "name,hotel_class,hotel_price,hotel_details,check_in_time,check_out_time";

/** Premium (Business+) fields — the API silently strips them on lower plans. */
const PREMIUM_FIELDS = new Set([
  "menu_items", "hotel_details", "hotel_price", "hotel_class",
  "ev_connectors", "ev_connector_types", "ev_network", "ev_max_power_kw", "ev_plug_count", "ev_stall_count", "ev_speed",
  "fuel_types", "fuel_price", "reviews", "historical_reviews", "review_sentiments",
]);

/**
 * When explicitly requested premium fields come back missing, say why. Without this a
 * model concludes "Location Drive has no review text" when the truth is "this key's
 * plan is below Business+".
 */
function withPlanNote(body: unknown, fields?: string) {
  if (!fields || fields.trim() === "*") return body;
  const requested = fields.split(",").map((f) => f.trim()).filter((f) => PREMIUM_FIELDS.has(f));
  if (requested.length === 0) return body;
  const record = (body as any)?.data ?? body;
  if (!record || typeof record !== "object") return body;
  const missing = requested.filter((f) => !(f in record));
  if (missing.length === 0) return body;
  return {
    ...(body as object),
    plan_note:
      `Requested premium field(s) not returned: ${missing.join(", ")}. Premium fields — including review text in ` +
      "reviews / historical_reviews — exist on Business+ plans and are silently stripped below that, so this key's plan " +
      "is most likely Free or Starter. Do not conclude the data does not exist; see https://locationdrive.com/pricing.",
  };
}

/** Server-level usage guidance injected into client context. */
export const SERVER_INSTRUCTIONS =
  "Location Drive is a global POI database (350M+ places, graded building polygons). " +
  "Call data_coverage first when unsure whether a country/region is covered. " +
  "Building-polygon tools need a Starter+ plan; premium fields (EV connectors, fuel prices, menus, hotel rates, review text) " +
  "and the get_review_history / get_hotel_rates tools need Business+ — plan errors say so explicitly. " +
  "Review text DOES exist on Business+: reviews (current crawl), historical_reviews (earlier crawls), and get_review_history " +
  "(both merged, de-duplicated). If those fields come back missing, the key's plan is below Business+ — say that, never that " +
  "Location Drive has no review data. get_place_context returns a summary plus review_sentiments keyword counts, not review text. " +
  "Review data is per place: there is no city- or country-wide search over review content. For 'which places near a point " +
  "have reviews mentioning X' use scan_reviews (scans up to 40 nearest places, one request each, returns matching snippets); " +
  "for one place use get_review_history. " +
  "ld_test_ keys return synthetic data without using quota.";

/**
 * Registers all Location Drive tools on an MCP server instance.
 * `getKey` resolves the customer's own API key (env var locally,
 * Authorization header remotely) — so plan gating, quotas, and usage
 * metering apply exactly as for direct API calls.
 */
export function registerTools(server: McpServer, getKey: () => string) {
  server.registerTool(
    "search_places",
    {
      title: "Search places",
      description:
        "Search the global Location Drive POI database by name or keyword. " +
        "Returns matching businesses/places with address, coordinates, rating, hours, and contact info. " +
        "Use for questions like 'find X in <city/country>' or when you have a business name to look up.",
      inputSchema: {
        query: z.string().min(2).describe("Name or keyword, e.g. 'Marriott' or 'coffee'"),
        country: z.string().length(2).optional().describe("ISO-2 country filter, e.g. 'US'"),
        category: z.string().optional().describe("Category filter, e.g. 'Restaurant'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
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
        "Use for 'what is near <lat,lng>', 'restaurants around this point', or local-area exploration.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (WGS84)"),
        longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (WGS84)"),
        radius_m: z.number().int().min(50).max(100000).optional().describe("Search radius in meters (default 1000)"),
        category: z.string().optional().describe("Category filter, e.g. 'Gas station'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)"),
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
        "Optionally request specific fields — including premium packs on Business+ plans: " +
        "menu_items (full menu: sections → items with structured prices), " +
        "hotel_details (room-rate offers from multiple booking sites, with links), hotel_price, hotel_class, " +
        "ev_connectors (per-connector type, power_kw, speed, plug_count) plus ev_connector_types, ev_network, " +
        "ev_max_power_kw, ev_plug_count, ev_stall_count, ev_speed, fuel_price, " +
        "reviews (current-cycle review text), historical_reviews (review text from earlier crawl cycles), review_sentiments. " +
        "Ask for fields=reviews,historical_reviews to read what reviewers actually wrote, or use get_review_history for the " +
        "merged, de-duplicated history. If requested premium fields are missing, the response carries a plan_note — the key's " +
        "plan is below Business+, not a gap in the data.",
      inputSchema: {
        place_id: z.string().describe("Location Drive place ID, e.g. 'ld_3GB7KWu3lxlI'"),
        fields: z.string().optional().describe("Comma-separated field list, or '*' for all plan-eligible fields"),
      },
      annotations: READ_ONLY,
    },
    async ({ place_id, fields }) => {
      try {
        return out(withPlanNote(await ld(getKey(), `/v1/places/${encodeURIComponent(place_id)}`, { fields }), fields));
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
        "instead; there is no city- or country-wide review search. Requires Business+.",
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
        "Cost: one nearby search plus one request per scanned place (≤41 API requests). Neighborhood scale only — " +
        "there is no city- or country-wide review search. Requires Business+ (review text). Snippets are user-submitted " +
        "opinions: read them before drawing conclusions and quote reviewers rather than labeling businesses.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees (WGS84)"),
        longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees (WGS84)"),
        keywords: z.array(z.string().min(2)).min(1).max(30)
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
        "Hotel fields require Business+; on lower plans they are stripped and only the name comes back.",
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
              "No room-rate data returned. hotel_* fields require a Business+ plan; on an eligible plan this means no rates are listed for this place.",
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
        "Returns GeoJSON ready for maps. Requires a Starter plan or above.",
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
        "and the business(es) inside. Location Drive's signature capability. Requires Starter plan or above.",
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
        "Use for 'how many <brand> locations are there', competitor analysis, or market sizing.",
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
        "Call this first when unsure whether a region is covered.",
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
