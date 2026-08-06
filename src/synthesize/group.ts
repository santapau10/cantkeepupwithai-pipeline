import { prisma } from "../lib/prisma.js";
import { embedTexts } from "../discover/embed.js";
import { greedyCluster } from "../discover/cluster.js";

export type PostGroup = {
  posts: { id: string; title: string; url: string; sourceName: string; postedAt: Date }[];
};

const SIMILARITY_THRESHOLD = 0.78; // slightly looser than discover's 0.82 — headline phrasing varies more across outlets than dev-forum titles do
const MIN_CLUSTER_SIZE = 2; // "synthesis of multiple posts" is the whole point of a digest story — a single outlet covering something alone isn't a group

/**
 * Story grouping for the digest, news sources only. This does NOT use the
 * trend taxonomy — general press mostly doesn't write about the same narrow
 * dev-tool trends the radar tracks (verified empirically: broadening
 * taxonomy aliases moved community matches 13->23 but news matches stayed
 * at 0). Instead: embed today's news post titles and cluster by topical
 * similarity, same primitives as the weekly discover stage. The LLM then
 * only writes prose for clusters that are already decided — grouping itself
 * is still not the model's job, just no longer taxonomy-anchored.
 *
 * Needs VOYAGE_API_KEY now, same as `discover` — this used to be a
 * weekly-only dependency, now it's on the daily path too.
 */
export async function groupTodaysTopStories(opts: { maxGroups?: number; maxPostsPerGroup?: number; hours?: number } = {}) {
  const { maxGroups = 5, maxPostsPerGroup = 8, hours = 48 } = opts;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const posts = await prisma.rawPost.findMany({
    where: { postedAt: { gte: since }, source: { kind: "news" } },
    include: { source: { select: { name: true } } },
  });

  if (posts.length === 0) return [];

  const embeddings = await embedTexts(posts.map((p) => p.title));
  const clusters = greedyCluster(
    posts.map((p, i) => ({ id: p.id, embedding: embeddings[i] })),
    SIMILARITY_THRESHOLD,
  ).filter((c) => c.memberIds.length >= MIN_CLUSTER_SIZE);

  const postById = new Map(posts.map((p) => [p.id, p]));

  const groups: PostGroup[] = clusters.map((cluster) => ({
    posts: cluster.memberIds
      .map((id) => postById.get(id)!)
      .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()) // no cross-outlet score to rank by — most recent first
      .slice(0, maxPostsPerGroup)
      .map((p) => ({ id: p.id, title: p.title, url: p.url, sourceName: p.source.name, postedAt: p.postedAt })),
  }));

  return groups.sort((a, b) => b.posts.length - a.posts.length).slice(0, maxGroups);
}
