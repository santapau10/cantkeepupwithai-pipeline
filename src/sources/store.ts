import { prisma } from "../lib/prisma.js";
import type { SourceConnector } from "./types.js";

export type IngestResult = {
  sourceName: string;
  fetched: number;
  stored: number;
  duplicatesSkipped?: number;
  error?: string;
};

// How far back to look for a cross-source duplicate. Matches the lookback
// window used elsewhere (aggregate, discover) — no strong reason to dedup
// against something from months ago, and it keeps the query bounded.
const DEDUP_WINDOW_DAYS = 7;

/**
 * Fetches one connector, upserts its Source row, dedups posts two ways:
 * (sourceId, externalId) for the same post re-seen by the same source, and
 * an exact case-insensitive title match against any OTHER source's recent
 * posts — catches the same article showing up via two feeds (e.g. HN
 * linking straight to a blog post that's also in the RSS feed, title
 * carried over verbatim), which would otherwise double-count as two
 * separate mentions on the trend radar. Same-story-different-wording
 * (three outlets covering one event in their own words) isn't caught here
 * — that needs semantic comparison, not exact match; not implemented yet.
 */
export async function ingestConnector(connector: SourceConnector): Promise<IngestResult> {
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
    posts = await connector.fetchRecent();
  } catch (err) {
    return { sourceName: connector.name, fetched: 0, stored: 0, error: (err as Error).message };
  }

  const since = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let stored = 0;
  let duplicatesSkipped = 0;

  for (const post of posts) {
    const duplicateElsewhere = await prisma.rawPost.findFirst({
      where: {
        title: { equals: post.title, mode: "insensitive" },
        postedAt: { gte: since },
        sourceId: { not: source.id },
      },
      select: { id: true },
    });
    if (duplicateElsewhere) {
      duplicatesSkipped++;
      continue;
    }

    const result = await prisma.rawPost.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId: post.externalId } },
      update: {}, // posts are immutable once seen — only insert new ones
      create: {
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
    if (result) stored++;
  }

  return { sourceName: connector.name, fetched: posts.length, stored, duplicatesSkipped };
}
