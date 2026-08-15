import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ld, out, fail, SLIM_FIELDS } from "./api.js";

/** Every Location Drive tool is a read-only query against an external API. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Server-level usage guidance injected into client context. */
export const SERVER_INSTRUCTIONS =
  "Location Drive is a global POI database (350M+ places, graded building polygons). " +
  "Call data_coverage first when unsure whether a country/region is covered. " +
  "Building-polygon tools need a Starter+ plan; premium fields (EV, fuel, menus, hotel rates, reviews) need Business+ — " +
  "plan errors say so explicitly. ld_test_ keys return synthetic data without using quota.";

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
        "Optionally request specific fields — including premium packs on eligible plans: " +
        "ev_connectors, ev_max_power_kw, fuel_price, menu_items, hotel_price, reviews.",
      inputSchema: {
        place_id: z.string().describe("Location Drive place ID, e.g. 'ld_3GB7KWu3lxlI'"),
        fields: z.string().optional().describe("Comma-separated field list, or '*' for all plan-eligible fields"),
      },
      annotations: READ_ONLY,
    },
    async ({ place_id, fields }) => {
      try {
        return out(await ld(getKey(), `/v1/places/${encodeURIComponent(place_id)}`, { fields }));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_place_context",
    {
      title: "Get place context (LLM-ready)",
      description:
        "LLM-ready context for one place: a natural-language summary plus structured data, " +
        "built for grounding answers about a specific business. Prefer this over get_place_details " +
        "when the goal is to describe or reason about the place rather than extract raw fields.",
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
