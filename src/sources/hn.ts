import type { NormalizedPost, SourceConnector } from "./types.js";

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1/search_by_date";

type AlgoliaHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
};

/**
 * Hacker News via the Algolia API — no auth, no key, generous limits.
 * Pulls recent stories (not a curated feed) since the taxonomy match step
 * decides what's relevant, not the source query.
 */
export class HackerNewsConnector implements SourceConnector {
  type = "hn";
  name = "Hacker News";
  kind = "community" as const;

  async fetchRecent(): Promise<NormalizedPost[]> {
    const since = Math.floor(Date.now() / 1000) - 48 * 60 * 60; // last 48h
    const url = `${ALGOLIA_BASE}?tags=story&numericFilters=created_at_i>${since}&hitsPerPage=200`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HN Algolia API error: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { hits: AlgoliaHit[] };

    return data.hits
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
}
