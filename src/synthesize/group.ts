import { prisma } from "../lib/prisma.js";

export type PostGroup = {
  trendName: string;
  tag: string;
  posts: { id: string; title: string; url: string; sourceName: string; score: number }[];
};

/**
 * Deterministic grouping: which posts belong in the same story is decided
 * by shared trend tag + recency + a score floor — no model call. The LLM
 * only writes prose from groups that are already decided.
 */
export async function groupTodaysTopStories(opts: { maxGroups?: number; maxPostsPerGroup?: number } = {}) {
  const { maxGroups = 5, maxPostsPerGroup = 8 } = opts;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const mentions = await prisma.postTrendMention.findMany({
    where: { post: { postedAt: { gte: since } } },
    include: {
      post: { include: { source: { select: { name: true } } } },
      trend: { select: { name: true, tag: true } },
    },
  });

  const groups = new Map<string, PostGroup>();
  for (const m of mentions) {
    const group = groups.get(m.trend.name) ?? { trendName: m.trend.name, tag: m.trend.tag, posts: [] };
    group.posts.push({
      id: m.post.id,
      title: m.post.title,
      url: m.post.url,
      sourceName: m.post.source.name,
      score: m.post.score,
    });
    groups.set(m.trend.name, group);
  }

  return [...groups.values()]
    .map((g) => ({ ...g, posts: g.posts.sort((a, b) => b.score - a.score).slice(0, maxPostsPerGroup) }))
    .sort((a, b) => b.posts.length - a.posts.length)
    .slice(0, maxGroups);
}
