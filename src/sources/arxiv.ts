import Parser from "rss-parser";
import type { FetchOptions, NormalizedPost, SourceConnector } from "./types.js";
import { truncateSnippet } from "./types.js";

const parser = new Parser();

// cs.AI (general AI), cs.CL (NLP/language models), cs.LG (machine learning)
// — the three categories most likely to contain agent/LLM-adjacent papers.
// ArXiv's query syntax ORs these into one call, no pagination needed at
// this volume.
const CATEGORIES = ["cs.AI", "cs.CL", "cs.LG"];
const MAX_RESULTS = 50;
// Capped, not exhaustive on the backfill path — same tradeoff as
// GitHubConnector's per_page cap, just a bigger number since ArXiv's daily
// volume across these three categories is much higher than repos-per-topic.
const MAX_BACKFILL_RESULTS = 300;
// Wider than HN's 48h — ArXiv has real submission-to-listing latency
// (observed ~3 days, longer over weekends), not near-real-time like a
// forum post. A tighter window here reliably returns 0 results on some
// days. Overlap with the previous day's run is fine — dedup is by
// externalId either way.
const WINDOW_DAYS = 5;

function buildQueryUrl(maxResults: number): string {
  const categoryQuery = CATEGORIES.map((c) => `cat:${c}`).join(" OR ");
  return (
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(categoryQuery)}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`
  );
}

export class ArxivConnector implements SourceConnector {
  type = "arxiv";
  name = "ArXiv";
  kind = "community" as const;

  async fetchRecent(options?: FetchOptions): Promise<NormalizedPost[]> {
    const windowDays = options?.days ?? WINDOW_DAYS;
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    // The query API has no `days` param — over-fetch by submission-date
    // order, then cut client-side to the actual window requested.
    const maxResults = options?.days ? MAX_BACKFILL_RESULTS : MAX_RESULTS;

    const feed = await parser.parseURL(buildQueryUrl(maxResults));

    return (feed.items ?? [])
      .filter((item) => item.link && item.title && item.isoDate && new Date(item.isoDate).getTime() >= cutoff)
      .map((item) => ({
        // arxiv.org/abs/<id>vN — externalId includes the version suffix, so
        // a paper revised after we've already stored it is treated as a
        // distinct post rather than silently overwriting the original.
        externalId: item.id ?? item.link!,
        // ArXiv titles come with embedded newlines/extra whitespace from
        // the source LaTeX.
        title: item.title!.replace(/\s+/g, " ").trim(),
        url: item.link!,
        snippet: truncateSnippet(item.summary?.replace(/\s+/g, " ")),
        author: item.author,
        score: 0,
        commentCount: 0,
        postedAt: new Date(item.isoDate!),
      }));
  }
}
