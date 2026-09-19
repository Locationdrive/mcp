// Usage: LOCATIONDRIVE_API_KEY=ld_live_xxx node scripts/smoke.mjs
// Exercises the documented endpoints every MCP tool depends on.
const key = process.env.LOCATIONDRIVE_API_KEY;
if (!key) { console.error("Set LOCATIONDRIVE_API_KEY"); process.exit(1); }
const base = process.env.LOCATIONDRIVE_API_BASE ?? "https://api.locationdrive.com";

const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });
const report = (ok, name, status, body) =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  HTTP ${status}  ${body.slice(0, 120).replace(/\n/g, " ")}`);

let failures = 0;
async function check(name, path) {
  const r = await get(path);
  const b = await r.text();
  report(r.ok, name, r.status, b);
  if (!r.ok) failures++;
  return b;
}

// Every endpoint is on every plan (API v8): a 403 means the key itself was denied.
// Also prints X-API-Calls-Counted so the counting rule can be eyeballed
// (list = limit, default 20; single/summary = 1).
async function checkCounted(name, path, expected) {
  const r = await get(path);
  const b = await r.text();
  const counted = r.headers.get("x-api-calls-counted");
  const good = r.ok && (expected === undefined || String(expected) === counted);
  report(good, `${name} [counted ${counted}${expected !== undefined ? ` / expected ${expected}` : ""}]`, r.status, b);
  if (!good) failures++;
  return b;
}

// search first — its top result feeds the by-ID checks
const searchBody = await checkCounted("search", "/v1/places/search?q=beach&limit=2&fields=id,name", 2);
let placeId;
try { placeId = JSON.parse(searchBody)?.data?.[0]?.id ?? JSON.parse(searchBody)?.results?.[0]?.id; } catch {}

await checkCounted("nearby", "/v1/places/nearby?lat=18.2170&lng=-63.0578&radius=2000&limit=2", 2);
await checkCounted("nearby-default-limit", "/v1/places/nearby?lat=18.2170&lng=-63.0578&radius=2000&fields=id", 20);
if (placeId) {
  await check("details", `/v1/places/${encodeURIComponent(placeId)}`);
  await check("hotel-rates", `/v1/places/${encodeURIComponent(placeId)}?fields=name,hotel_class,hotel_price,hotel_details,check_in_time,check_out_time`);
  await checkCounted("reviews-summary", `/v1/places/${encodeURIComponent(placeId)}/reviews/summary`, 1);
  await checkCounted("context", `/v1/ai/context/${encodeURIComponent(placeId)}`, 1);
} else {
  console.log("SKIP  details  (no place id from search)"); failures++;
}
await check("coverage", "/v1/polygons/coverage?country=AI");
await check("countries", "/v1/countries");
await checkCounted("brand", "/v1/brands/Starbucks/summary", 1);
await checkCounted("brand-locations", "/v1/brands/Starbucks/locations?country=US&limit=2&fields=id,name", 2);
await checkCounted("autocomplete", "/v1/autocomplete?q=bea&country=AI", 1);

process.exit(failures ? 1 : 0);
