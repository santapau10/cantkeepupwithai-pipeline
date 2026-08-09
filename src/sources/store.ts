import { prisma } from "../lib/prisma.js";
import type { FetchOptions, NormalizedPost, SourceConnector } from "./types.js";

export type IngestResult = {
  sourceName: string;
  fetched: number;
  stored: number;
  duplicatesSkipped?: number;
  error?: string;
};

// How far back to look for a cross-source duplicate, relative to *the
// incoming post's own date* (see below) — not to "now". Matches the
// lookback window used elsewhere (aggregate, discover) — no strong reason
// to dedup against something from months ago, and it keeps the query
// bounded.
const DEDUP_WINDOW_DAYS = 7;
// Small forward buffer past the post's own date — a duplicate on another
// source can land a day later (different timezone, different crawl time),
// not just earlier.
const DEDUP_FORWARD_BUFFER_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches one connector, upserts its Source row, dedups posts two ways:
 * (sourceId, externalId) for the same post re-seen by the same source, and
 * an exact case-insensitive title match against any OTHER source's posts
 * from around the same time — catches the same article showing up via two
 * feeds (e.g. HN linking straight to a blog post that's also in the RSS
 * feed, title carried over verbatim), which would otherwise double-count as
 * two separate mentions on the trend radar. Windowed on each post's own
 * `postedAt`, not on `Date.now()` — the daily path made those look
 * equivalent (an incoming post is always ~today), but `backfill` ingests
 * posts dated weeks ago, where anchoring to "now" would silently stop
 * catching cross-source duplicates for anything older than a week.
 * Same-story-different-wording (three outlets covering one event in their
 * own words) isn't caught here — that needs semantic comparison, not exact
 * match; not implemented yet.
 *
 * Batched, not per-post: this used to run two queries (cross-source dup
 * check, then existing-row check) *for every post*, sequentially — fine at
 * daily volume, but a 30-day backfill's ~6,000 HN posts alone meant 12,000
 * round trips to Neon and a 54-minute `ingest` stage. Two queries total per
 * connector call instead, everything else done in memory.
 */
export async function ingestConnector(connector: SourceConnector, options?: FetchOptions): Promise<IngestResult> {
  const source = await prisma.source.upsert({
    where: { name: connector.name },
    update: { enabled: true, kind: connector.kind },
    create: {
      type: connector.type,
      kind: connector.kind,
      name: connector.name,
      config: JSON.stringify({}),
      enabled: true,
    },
  });

  let posts: NormalizedPost[];
  try {
    posts = await connector.fetchRecent(options);
  } catch (err) {
    return { sourceName: connector.name, fetched: 0, stored: 0, error: (err as Error).message };
  }

  if (posts.length === 0) {
    return { sourceName: connector.name, fetched: 0, stored: 0, duplicatesSkipped: 0 };
  }

  // One query covering every incoming post's own dedup window, instead of
  // one query per post — the per-post check below is then just an in-memory
  // lookup against this.
  const times = posts.map((p) => p.postedAt.getTime());
  const batchWindowStart = new Date(Math.min(...times) - DEDUP_WINDOW_DAYS * DAY_MS);
  const batchWindowEnd = new Date(Math.max(...times) + DEDUP_FORWARD_BUFFER_DAYS * DAY_MS);

  const [otherSourcePosts, existingForThisSource] = await Promise.all([
    prisma.rawPost.findMany({
      where: { postedAt: { gte: batchWindowStart, lte: batchWindowEnd }, sourceId: { not: source.id } },
      select: { title: true, postedAt: true },
    }),
    prisma.rawPost.findMany({
      where: { sourceId: source.id, externalId: { in: posts.map((p) => p.externalId) } },
      select: { externalId: true },
    }),
  ]);

  const otherByTitle = new Map<string, Date[]>();
  for (const p of otherSourcePosts) {
    const key = p.title.toLowerCase();
    const list = otherByTitle.get(key);
    if (list) list.push(p.postedAt);
    else otherByTitle.set(key, [p.postedAt]);
  }
  const existingExternalIds = new Set(existingForThisSource.map((p) => p.externalId));

  const toInsert: NormalizedPost[] = [];
  let duplicatesSkipped = 0;

  for (const post of posts) {
    if (existingExternalIds.has(post.externalId)) continue; // posts are immutable once seen — no-op, not "stored"

    const candidates = otherByTitle.get(post.title.toLowerCase());
    const windowStart = post.postedAt.getTime() - DEDUP_WINDOW_DAYS * DAY_MS;
    const windowEnd = post.postedAt.getTime() + DEDUP_FORWARD_BUFFER_DAYS * DAY_MS;
    const hasCrossSourceDup = candidates?.some((d) => d.getTime() >= windowStart && d.getTime() <= windowEnd);
    if (hasCrossSourceDup) {
      duplicatesSkipped++;
      continue;
    }

    toInsert.push(post);
  }

  // skipDuplicates as a safety net against the (sourceId, externalId)
  // unique constraint, not the primary dedup mechanism — the check above
  // already filtered those out; this just covers a same-batch collision or
  // a race with a concurrent run.
  const { count: stored } = toInsert.length
    ? await prisma.rawPost.createMany({
        data: toInsert.map((post) => ({
          sourceId: source.id,
          externalId: post.externalId,
          title: post.title,
          url: post.url,
          author: post.author,
          score: post.score,
          commentCount: post.commentCount,
          postedAt: post.postedAt,
        })),
        skipDuplicates: true,
      })
    : { count: 0 };

  return { sourceName: connector.name, fetched: posts.length, stored, duplicatesSkipped };
}
