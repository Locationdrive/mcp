import { VERSION } from "./version.js";

/** Minimal Location Drive API client used by every tool. */
const BASE = process.env.LOCATIONDRIVE_API_BASE ?? "https://api.locationdrive.com";
/** Every upstream call is bounded; override for ops/testing with LOCATIONDRIVE_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = Number(process.env.LOCATIONDRIVE_TIMEOUT_MS) || 20_000;

export class LDError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function ld(
  apiKey: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": `locationdrive-mcp/${VERSION}` },
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new LDError(504, "UPSTREAM_TIMEOUT", `Upstream request timed out after ${timeoutMs} ms`);
    }
    throw e;
  }
  const text = await res.text();
  let body: any = null;
  let isJson = true;
  try { body = JSON.parse(text); } catch { isJson = false; }
  if (!res.ok) {
    // Never relay raw upstream bodies (WAF/CDN error pages) to the model.
    const code = isJson ? String(body?.code ?? `HTTP_${res.status}`) : `HTTP_${res.status}`;
    const msg = isJson
      ? clean(String(body?.message ?? body?.error ?? "Request failed"))
      : `Upstream returned a non-JSON ${res.status} response`;
    throw new LDError(res.status, code, msg);
  }
  if (!isJson) throw new LDError(res.status, "BAD_UPSTREAM_BODY", "Upstream returned a non-JSON success response");
  return body;
}

/** Bound and strip control characters from text that came from upstream. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

/** Compact default field set - keeps agent context windows lean. */
export const SLIM_FIELDS =
  "id,name,category,formatted_address,city,country_code,latitude,longitude," +
  "rating,review_count,phone,website,opening_hours,status,brand";

/** Uniform result formatting for MCP text content (compact JSON — saves agent tokens). */
export function out(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/** api_calls_counted from a JSON response body — the API calls the request was
 *  charged (places returned for list endpoints, 1 for single-place and summary
 *  requests). Present on every API response since 2026-09-18. */
export function countedCalls(body: unknown): number | undefined {
  const n = (body as any)?.api_calls_counted;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
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
