import { VERSION } from "./version.js";

/** Minimal Location Drive API client used by every tool. */
const BASE = process.env.LOCATIONDRIVE_API_BASE ?? "https://api.locationdrive.com";

export class LDError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function ld(
  apiKey: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
  timeoutMs?: number,
): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": `locationdrive-mcp/${VERSION}` },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const code = body?.code ?? `HTTP_${res.status}`;
    const msg = body?.message ?? body?.error ?? "Request failed";
    throw new LDError(res.status, code, msg);
  }
  return body;
}

/** Compact default field set - keeps agent context windows lean. */
export const SLIM_FIELDS =
  "id,name,category,formatted_address,city,country_code,latitude,longitude," +
  "rating,review_count,phone,website,opening_hours,status,brand";

/** Uniform result formatting for MCP text content (compact JSON — saves agent tokens). */
export function out(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/** Documented API error codes: FORBIDDEN (403) = plan does not include this
 *  endpoint/field; RATE_LIMITED (429) = monthly quota or rate limit exceeded.
 *  Legacy PLAN_REQUIRED / QUOTA_EXCEEDED aliases are kept as fallbacks. */
export function fail(e: unknown) {
  let m: string;
  if (e instanceof LDError) {
    if (e.status === 403 || e.code === "FORBIDDEN" || e.code === "PLAN_REQUIRED") {
      m = `This data requires a higher Location Drive plan. ${e.message} — see https://locationdrive.com/pricing`;
    } else if (e.status === 429 || e.code === "RATE_LIMITED" || e.code === "QUOTA_EXCEEDED") {
      m = `Rate limit or monthly quota exceeded for this API key. ${e.message}`;
    } else {
      m = `Location Drive API error ${e.status} (${e.code}): ${e.message}`;
    }
  } else {
    m = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { content: [{ type: "text" as const, text: m }], isError: true };
}
