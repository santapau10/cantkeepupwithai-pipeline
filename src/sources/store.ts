import { prisma } from "../lib/prisma.js";
import type { FetchOptions, NormalizedPost, SourceConnector } from "./types.js";
import { embedTexts } from "../discover/embed.js";
import { cosineSimilarity } from "../discover/cluster.js";

export type IngestResult = {
  sourceName: string;
  fetched: number;
  stored: number;
  crossSourceGrouped?: number;
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

// Same-event, not same-topic — much stricter than discover's 0.75 (topic
// clustering, groups posts about the same general subject) or tag's 0.7
// (post-title vs. trend-description matching). This is asking "is this the
// same real-world story, paraphrased by a different outlet" — spot-checked
// against real cross-source pairs on voyage-4-lite: same-event coverage
// from different sources scored >=0.90, while same-topic-different-story
// pairs (two unrelated posts both about, say, MCP auth) sat lower. A looser
// threshold here would wrongly merge distinct stories into one group and
// understate genuine cross-source fan-out — the opposite of what this
// exists to measure.
const SEMANTIC_DEDUP_THRESHOLD = 0.9;

type CrossSourceCandidate = { id: string; title: string; postedAt: Date; storyGroupId: string | null };

/**
 * Fetches one connector and stores its posts, resolving two kinds of
 * duplicate: (sourceId, externalId) for the same post re-seen by the same
 * source (a true no-op, never stored twice), and the same real-world story
 * showing up via a DIFFERENT source — checked first by exact
 * case-insensitive title match, then (if VOYAGE_API_KEY is set and this
 * isn't a backfill) by embedding similarity for paraphrased coverage of the
 * same event.
 *
 * Cross-source duplicates are no longer dropped. Every post is still
 * stored, but a post recognized as covering a story already seen from
 * another source gets that story's `storyGroupId` (propagated from the
 * matched post, or minted from its id if this is the first repeat seen) —
 * so `raw_posts.storyGroupId` naturally chains every source's coverage of
 * one story together. Dropping used to throw away the exact signal this
 * project wants: how many *independent* sources are talking about the same
 * thing, not just how many posts exist. `aggregate/snapshot.ts` counts
 * distinct story groups per trend per day (not raw post rows) so this
 * doesn't inflate mention counts — three outlets on one story still counts
 * as one story, but now the cross-source spread is queryable instead of
 * silently discarded.
 *
 * Batched, not per-post — see the original comment history for why (a
 * 30-day backfill's ~6,000 HN posts made per-post queries a 54-minute
 * stage). The embedding pass adds real API calls, so it's skipped entirely
 * during backfill (`options?.days` set) to keep that path bounded — the
 * exact-title pass still runs regardless of backfill.
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
    return { sourceName: connector.name, fetched: 0, stored: 0, crossSourceGrouped: 0 };
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
      select: { id: true, title: true, postedAt: true, storyGroupId: true },
    }),
    prisma.rawPost.findMany({
      where: { sourceId: source.id, externalId: { in: posts.map((p) => p.externalId) } },
      select: { externalId: true },
    }),
  ]);

  const otherByTitle = new Map<string, CrossSourceCandidate[]>();
  for (const p of otherSourcePosts) {
    const key = p.title.toLowerCase();
    const list = otherByTitle.get(key);
    if (list) list.push(p);
    else otherByTitle.set(key, [p]);
  }
  const existingExternalIds = new Set(existingForThisSource.map((p) => p.externalId));

  type Pending = { post: NormalizedPost; storyGroupId: string | null };
  const pending: Pending[] = [];
  const unmatched: NormalizedPost[] = []; // still need the semantic pass

  const withinWindow = (post: NormalizedPost, candidate: { postedAt: Date }) => {
    const windowStart = post.postedAt.getTime() - DEDUP_WINDOW_DAYS * DAY_MS;
    const windowEnd = post.postedAt.getTime() + DEDUP_FORWARD_BUFFER_DAYS * DAY_MS;
    const t = candidate.postedAt.getTime();
    return t >= windowStart && t <= windowEnd;
  };

  for (const post of posts) {
    if (existingExternalIds.has(post.externalId)) continue; // posts are immutable once seen — no-op, not "stored"

    const exactMatch = (otherByTitle.get(post.title.toLowerCase()) ?? []).find((c) => withinWindow(post, c));
    if (exactMatch) {
      pending.push({ post, storyGroupId: exactMatch.storyGroupId ?? exactMatch.id });
    } else {
      unmatched.push(post);
    }
  }

  let crossSourceGrouped = pending.length;

  const canRunSemanticPass = unmatched.length > 0 && otherSourcePosts.length > 0 && Boolean(process.env.VOYAGE_API_KEY) && !options?.days;
  if (canRunSemanticPass) {
    try {
      const [postEmbeddings, candidateEmbeddings] = await Promise.all([
        embedTexts(unmatched.map((p) => p.title)),
        embedTexts(otherSourcePosts.map((c) => c.title)),
      ]);

      for (let i = 0; i < unmatched.length; i++) {
        const post = unmatched[i];
        let best: CrossSourceCandidate | null = null;
        let bestScore = -1;
        for (let j = 0; j < otherSourcePosts.length; j++) {
          const candidate = otherSourcePosts[j];
          if (!withinWindow(post, candidate)) continue;
          const score = cosineSimilarity(postEmbeddings[i], candidateEmbeddings[j]);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        if (best && bestScore >= SEMANTIC_DEDUP_THRESHOLD) {
          pending.push({ post, storyGroupId: best.storyGroupId ?? best.id });
          crossSourceGrouped++;
        } else {
          pending.push({ post, storyGroupId: null });
        }
      }
    } catch (err) {
      // Same graceful-degradation pattern as tag's embedding fallback pass —
      // a Voyage hiccup (rate limit, outage, missing billing) here must
      // never block ingest. Falls back to storing these ungrouped; the
      // exact-title pass above already ran regardless.
      console.warn(`Semantic cross-source dedup skipped for ${connector.name}: ${(err as Error).message}`);
      for (const post of unmatched) pending.push({ post, storyGroupId: null });
    }
  } else {
    for (const post of unmatched) pending.push({ post, storyGroupId: null });
  }

  // skipDuplicates as a safety net against the (sourceId, externalId)
  // unique constraint, not the primary dedup mechanism — the check above
  // already filtered those out; this just covers a same-batch collision or
  // a race with a concurrent run.
  const { count: stored } = pending.length
    ? await prisma.rawPost.createMany({
        data: pending.map(({ post, storyGroupId }) => ({
          sourceId: source.id,
          externalId: post.externalId,
          title: post.title,
          url: post.url,
          snippet: post.snippet,
          author: post.author,
          score: post.score,
          commentCount: post.commentCount,
          postedAt: post.postedAt,
          storyGroupId,
        })),
        skipDuplicates: true,
      })
    : { count: 0 };

  return { sourceName: connector.name, fetched: posts.length, stored, crossSourceGrouped };
}
