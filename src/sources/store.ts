import { prisma } from "../lib/prisma.js";
import type { SourceConnector } from "./types.js";

export type IngestResult = { sourceName: string; fetched: number; stored: number; error?: string };

/** Fetches one connector, upserts its Source row, dedups posts by (sourceId, externalId). */
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

  let stored = 0;
  for (const post of posts) {
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

  return { sourceName: connector.name, fetched: posts.length, stored };
}
