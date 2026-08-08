import type { FetchOptions, NormalizedPost, SourceConnector } from "./types.js";

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1/search_by_date";
const DAILY_WINDOW_HOURS = 48;
const HITS_PER_PAGE = 200; // matches the daily path's cap, reused per day-bucket on a backfill

type AlgoliaHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
};

function mapHits(hits: AlgoliaHit[]): NormalizedPost[] {
  return hits
    .filter((hit) => hit.title)
    .map((hit) => ({
      externalId: hit.objectID,
      title: hit.title!,
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author,
      score: hit.points ?? 0,
      commentCount: hit.num_comments ?? 0,
      postedAt: new Date(hit.created_at_i * 1000),
    }));
}

async function fetchWindow(sinceSec: number, untilSec: number): Promise<AlgoliaHit[]> {
  const url =
    `${ALGOLIA_BASE}?tags=story&numericFilters=created_at_i>${sinceSec},created_at_i<${untilSec}` +
    `&hitsPerPage=${HITS_PER_PAGE}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HN Algolia API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { hits: AlgoliaHit[] };
  return data.hits;
}

/**
 * Hacker News via the Algolia API — no auth, no key, generous limits.
 * Pulls recent stories (not a curated feed) since the taxonomy match step
 * decides what's relevant, not the source query.
 */
export class HackerNewsConnector implements SourceConnector {
  type = "hn";
  name = "Hacker News";
  kind = "community" as const;

  async fetchRecent(options?: FetchOptions): Promise<NormalizedPost[]> {
    const nowSec = Math.floor(Date.now() / 1000);

    // Daily path, unchanged: one call, last 48h.
    if (!options?.days) {
      const hits = await fetchWindow(nowSec - DAILY_WINDOW_HOURS * 60 * 60, nowSec + 1);
      return mapHits(hits);
    }

    // Backfill path: `search_by_date` is capped at HITS_PER_PAGE results per
    // call regardless of window size, so a single 30-day query would silently
    // drop everything past the first ~200 stories. Bucket by day instead —
    // same per-day density as the daily path, just repeated `days` times.
    const dedupById = new Map<string, AlgoliaHit>();
    for (let d = options.days; d >= 1; d--) {
      const bucketEnd = nowSec - (d - 1) * 24 * 60 * 60;
      const bucketStart = bucketEnd - 24 * 60 * 60;
      const hits = await fetchWindow(bucketStart, bucketEnd);
      for (const hit of hits) dedupById.set(hit.objectID, hit);
    }
    return mapHits([...dedupById.values()]);
  }
}
