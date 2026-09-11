import { ld, LDError } from "./api.js";

/**
 * scan_reviews — the one fan-out tool. Runs the nearby search, then fetches each
 * place's merged review history (/reviews/summary, Business+) and returns only the
 * review snippets that match the caller's keywords. Neighborhood scale by design:
 * at most `limit` (≤40) places, one API request each, bounded concurrency and a
 * soft deadline that stays inside the hosted function's 60 s limit.
 */

export interface ReviewHit {
  keywords_hit: string[];
  rating?: number;
  date?: string;
  source?: string;
  text: string;
}

export interface PlaceScan {
  place_id: string;
  name?: string;
  category?: string;
  address?: string;
  distance_m?: number;
  rating?: number;
  review_count?: number;
  reviews_scanned: number;
  matched_reviews: number;
  snippets: ReviewHit[];
}

export interface ScanResult {
  scanned_places: number;
  places_with_matches: number;
  reviews_scanned: number;
  api_requests: number;
  partial: boolean;
  keywords: string[];
  matches: PlaceScan[];
  no_match_places: string[];
  fetch_errors: number;
  note: string;
}

export interface ScanOptions {
  latitude: number;
  longitude: number;
  radius_m: number;
  keywords: string[];
  category?: string;
  limit: number;
  max_snippets_per_place: number;
}

const CONCURRENCY = 6;
const SOFT_DEADLINE_MS = 45_000;      // Vercel maxDuration is 60 s — leave headroom
const PER_REQUEST_TIMEOUT_MS = 15_000;
const SNIPPET_PAD = 140;
const NEARBY_FIELDS = "id,name,category,formatted_address,rating,review_count,distance_m";

/**
 * Normalize text for matching: NFKC, lowercase, drop Arabic tashkeel / tatweel /
 * superscript alef, unify alef variants, ى→ي, ة→ه. Returns the normalized string
 * and a map from each normalized index back to the NFKC'd source index, so
 * snippets can be cut from the original text (diacritics and casing intact).
 */
export function normalizeWithMap(input: string): { norm: string; map: number[]; src: string } {
  const src = input.normalize("NFKC");
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const code = ch.charCodeAt(0);
    if ((code >= 0x064b && code <= 0x0652) || code === 0x0670 || code === 0x0640) continue;
    let out = ch.toLowerCase();
    if (out === "أ" || out === "إ" || out === "آ" || out === "ٱ") out = "ا";
    else if (out === "ى") out = "ي";
    else if (out === "ة") out = "ه";
    for (let k = 0; k < out.length; k++) {
      norm += out[k];
      map.push(i);
    }
  }
  return { norm, map, src };
}

export function normalizeKeyword(keyword: string): string {
  return normalizeWithMap(keyword).norm.trim();
}

function cut(src: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_PAD);
  const to = Math.min(src.length, end + SNIPPET_PAD);
  return (from > 0 ? "…" : "") + src.slice(from, to).replace(/\s+/g, " ").trim() + (to < src.length ? "…" : "");
}

/** Which keywords hit this review text, plus a snippet around the earliest hit. */
export function matchReview(
  text: string,
  keywords: { raw: string; norm: string }[],
): { keywords_hit: string[]; snippet: string } | null {
  if (!text) return null;
  const { norm, map, src } = normalizeWithMap(text);
  const hits: string[] = [];
  let first: { s: number; e: number } | null = null;
  for (const k of keywords) {
    if (!k.norm) continue;
    const idx = norm.indexOf(k.norm);
    if (idx === -1) continue;
    hits.push(k.raw);
    const s = map[idx];
    const e = (map[idx + k.norm.length - 1] ?? map[map.length - 1]) + 1;
    if (!first || s < first.s) first = { s, e };
  }
  if (hits.length === 0 || !first) return null;
  return { keywords_hit: hits, snippet: cut(src, first.s, first.e) };
}

function isFatal(e: unknown): boolean {
  return e instanceof LDError && (
    e.status === 401 || e.status === 403 || e.status === 429 ||
    e.code === "FORBIDDEN" || e.code === "PLAN_REQUIRED" || e.code === "RATE_LIMITED" || e.code === "QUOTA_EXCEEDED"
  );
}

export async function scanReviews(apiKey: string, opts: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const kws = opts.keywords
    .map((raw) => ({ raw, norm: normalizeKeyword(raw) }))
    .filter((k) => k.norm.length > 0);

  const nearby: any = await ld(apiKey, "/v1/places/nearby", {
    lat: opts.latitude, lng: opts.longitude, radius: opts.radius_m,
    category: opts.category, limit: opts.limit, fields: NEARBY_FIELDS,
  }, PER_REQUEST_TIMEOUT_MS);
  const places: any[] = (nearby?.data ?? nearby?.results ?? []).slice(0, opts.limit);

  let apiRequests = 1;
  let fatal: unknown = null;
  let partial = false;
  let fetchErrors = 0;
  let reviewsScanned = 0;
  const scans: (PlaceScan | null)[] = new Array(places.length).fill(null);
  let next = 0;

  const worker = async () => {
    for (;;) {
      if (fatal) return;
      if (Date.now() - started > SOFT_DEADLINE_MS) { partial = true; return; }
      const i = next++;
      if (i >= places.length) return;
      const p = places[i];
      const id = String(p?.id ?? "");
      if (!id) continue;
      apiRequests++;
      let body: any;
      try {
        body = await ld(apiKey, `/v1/places/${encodeURIComponent(id)}/reviews/summary`, {}, PER_REQUEST_TIMEOUT_MS);
      } catch (e) {
        if (isFatal(e)) { fatal = e; return; }
        fetchErrors++;
        continue;
      }
      const reviews: any[] = body?.reviews ?? body?.data?.reviews ?? [];
      reviewsScanned += reviews.length;
      const snippets: ReviewHit[] = [];
      let matched = 0;
      for (const r of reviews) {
        const hit = matchReview(String(r?.text ?? ""), kws);
        if (!hit) continue;
        matched++;
        if (snippets.length < opts.max_snippets_per_place) {
          snippets.push({ keywords_hit: hit.keywords_hit, rating: r?.rating, date: r?.date, source: r?.source, text: hit.snippet });
        }
      }
      scans[i] = {
        place_id: id, name: p.name, category: p.category, address: p.formatted_address,
        distance_m: p.distance_m, rating: p.rating, review_count: p.review_count,
        reviews_scanned: reviews.length, matched_reviews: matched, snippets,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, places.length) }, worker));
  if (fatal) throw fatal;

  const done = scans.filter((s): s is PlaceScan => s !== null);
  const matches = done
    .filter((s) => s.matched_reviews > 0)
    .sort((a, b) => b.matched_reviews - a.matched_reviews || (a.distance_m ?? 0) - (b.distance_m ?? 0));
  const noMatch = done.filter((s) => s.matched_reviews === 0).map((s) => s.name ?? s.place_id);

  return {
    scanned_places: done.length,
    places_with_matches: matches.length,
    reviews_scanned: reviewsScanned,
    api_requests: apiRequests,
    partial,
    keywords: kws.map((k) => k.raw),
    matches,
    no_match_places: noMatch,
    fetch_errors: fetchErrors,
    note:
      (partial ? "Time limit reached before every nearby place was scanned; results are partial. " : "") +
      `Scanned ${done.length} of the nearest places only — this is a neighborhood scan, not a city- or country-wide search. ` +
      "Keyword matching is a coarse filter over user-submitted review text: read the snippets before drawing conclusions, " +
      "quote reviewers rather than labeling businesses, and treat a place with no match as unchecked for other phrasings, not cleared.",
  };
}
