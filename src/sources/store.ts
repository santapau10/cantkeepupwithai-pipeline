import { prisma } from "../lib/prisma.js";
import type { FetchOptions, SourceConnector } from "./types.js";

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

  let posts;
  try {
    posts = await connector.fetchRecent(options);
  } catch (err) {
    return { sourceName: connector.name, fetched: 0, stored: 0, error: (err as Error).message };
  }

  let stored = 0;
  let duplicatesSkipped = 0;

  for (const post of posts) {
    const windowStart = new Date(post.postedAt.getTime() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(post.postedAt.getTime() + DEDUP_FORWARD_BUFFER_DAYS * 24 * 60 * 60 * 1000);
    const duplicateElsewhere = await prisma.rawPost.findFirst({
      where: {
        title: { equals: post.title, mode: "insensitive" },
        postedAt: { gte: windowStart, lte: windowEnd },
        sourceId: { not: source.id },
      },
      select: { id: true },
    });
    if (duplicateElsewhere) {
      duplicatesSkipped++;
      continue;
    }

    // Explicit find-then-create instead of upsert(update: {}) — an upsert's
    // return value doesn't say whether it went through the create or update
    // branch, so counting `stored` off of it (as this used to) claimed every
    // already-seen post as newly stored too. Posts are immutable once seen,
    // so an existing row is a true no-op, not a "stored" one.
    const existing = await prisma.rawPost.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId: post.externalId } },
      select: { id: true },
    });
    if (!existing) {
      await prisma.rawPost.create({
        data: {
          sourceId: source.id,
          externalId: post.externalId,
          title: post.title,
          url: post.url,
          author: post.author,
          score: post.score,
          commentCount: post.commentCount,
          postedAt: post.postedAt,
        },
      });
      stored++;
    }
  }

  return { sourceName: connector.name, fetched: posts.length, stored, duplicatesSkipped };
}
