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

// search first — its top result feeds the by-ID checks
const searchBody = await check("search", "/v1/places/search?q=beach&limit=2&fields=id,name");
let placeId;
try { placeId = JSON.parse(searchBody)?.data?.[0]?.id ?? JSON.parse(searchBody)?.results?.[0]?.id; } catch {}

await check("nearby", "/v1/places/nearby?lat=18.2170&lng=-63.0578&radius=2000&limit=2");
if (placeId) {
  await check("details", `/v1/places/${encodeURIComponent(placeId)}`);
} else {
  console.log("SKIP  details  (no place id from search)"); failures++;
}
await check("coverage", "/v1/polygons/coverage?country=AI");
await check("countries", "/v1/countries");
await check("brand", "/v1/brands/Starbucks/summary");

process.exit(failures ? 1 : 0);
