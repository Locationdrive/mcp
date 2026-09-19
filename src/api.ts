import { VERSION } from "./version.js";

/** Minimal Location Drive API client used by every tool. */
const BASE = process.env.LOCATIONDRIVE_API_BASE ?? "https://api.locationdrive.com";
/** Every upstream call is bounded; override for ops/testing with LOCATIONDRIVE_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = Number(process.env.LOCATIONDRIVE_TIMEOUT_MS) || 10_000;

/** List tools send the API's own default page size and never more unless the caller sets `limit`. */
export const DEFAULT_LIST_LIMIT = 20;
/** Upper bound for max_results auto-pagination (50 pages of 20). */
export const MAX_RESULTS_CAP = 1000;
/** Hard stop on pages per auto-paginated call, whatever the plan page size. */
const MAX_PAGES = 100;

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
  // Every authenticated response carries X-API-Calls-Counted; the body field is
  // only on 200s. Surface the header value when the body lacks it so every tool
  // result reports what the request cost.
  if (body && typeof body === "object" && !Array.isArray(body) && body.api_calls_counted === undefined) {
    const h = res.headers.get("x-api-calls-counted");
    if (h !== null && h.trim() !== "") {
      const n = Number(h);
      if (Number.isFinite(n)) body.api_calls_counted = n;
    }
  }
  return body;
}

export interface ListOptions {
  /** Page size; the API charges each page as its limit (plan-capped). Default 20. */
  limit?: number;
  /** Total results wanted; pages automatically (≤ MAX_RESULTS_CAP) and sums api_calls_counted. */
  max_results?: number;
}

/**
 * Fetch a list endpoint, paging automatically when `max_results` asks for more
 * than one page. Cost: each page counts as its `limit` (default 20, capped at the
 * plan's results per request) whatever it returns; the summed total is reported
 * as api_calls_counted. Without max_results the single page passes through as-is.
 */
export async function ldList(
  apiKey: string,
  path: string,
  params: Record<string, string | number | undefined>,
  opts: ListOptions = {},
): Promise<unknown> {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const target = opts.max_results ? Math.min(opts.max_results, MAX_RESULTS_CAP) : undefined;
  const first: any = await ld(apiKey, path, { ...params, limit, page: 1 });
  if (!target) return first;
  const rowsOf = (b: any): unknown[] => (Array.isArray(b?.data) ? b.data : []);
  const data: unknown[] = [...rowsOf(first)];
  const effLimit = Number(first?.pagination?.limit) || limit;   // the plan may cap the requested limit
  let counted = countedCalls(first) ?? effLimit;
  let pages = 1;
  let hasMore = Boolean(first?.pagination?.has_more);
  while (hasMore && data.length < target && pages < MAX_PAGES) {
    pages++;
    const next: any = await ld(apiKey, path, { ...params, limit, page: pages });
    const rows = rowsOf(next);
    data.push(...rows);
    counted += countedCalls(next) ?? effLimit;
    hasMore = Boolean(next?.pagination?.has_more) && rows.length > 0;
  }
  const out: Record<string, unknown> = {
    data: data.slice(0, target),
    pagination: {
      pages_fetched: pages,
      limit: effLimit,
      returned: Math.min(data.length, target),
      has_more: hasMore || data.length > target,
      max_results: target,
    },
    api_calls_counted: counted,
  };
  if (first?.total !== undefined) out.total = first.total;
  else if (first?.pagination?.total != null) out.total = first.pagination.total;
  return out;
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
 *  charged (its limit for list endpoints, the plan page for POST body endpoints,
 *  1 for single-place and summary requests). In the body of every 200 since
 *  2026-09-18; ld() also fills it from the X-API-Calls-Counted header. */
export function countedCalls(body: unknown): number | undefined {
  const n = (body as any)?.api_calls_counted;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** API error semantics: 401 = missing/invalid key; 403 = the key was denied
 *  (inactive, revoked, or its IP allowlist blocks this source) — since API v8
 *  there is no plan gating on fields or endpoints; 429 QUOTA_EXCEEDED = the
 *  monthly API-call allowance is exhausted (requests per second are fair-use
 *  guidance, not a limiter; the refused request is not counted). */
export function fail(e: unknown) {
  let m: string;
  if (e instanceof LDError) {
    if (e.status === 403 || e.code === "FORBIDDEN" || e.code === "PLAN_REQUIRED") {
      m = `Access denied for this API key (inactive, revoked, or blocked by its IP allowlist). ${e.message} — check the key at https://locationdrive.com/dashboard/api-keys`;
    } else if (e.status === 429 || e.code === "RATE_LIMITED" || e.code === "QUOTA_EXCEEDED") {
      m = `Monthly API-call allowance exceeded for this API key (429 QUOTA_EXCEEDED) — the refused request was not counted. Wait for the monthly reset (1st, 00:00 UTC) or upgrade at https://locationdrive.com/dashboard/billing. ${e.message}`;
    } else {
      m = `Location Drive API error ${e.status} (${e.code}): ${e.message}`;
    }
  } else {
    m = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { content: [{ type: "text" as const, text: m }], isError: true };
}
