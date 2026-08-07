import { prisma } from "../lib/prisma.js";
import { embedTexts } from "../discover/embed.js";
import { cosineSimilarity } from "../discover/cluster.js";

// Conservative on purpose — a false match here silently inflates a public
// trend's mention count, unlike a bad digest cluster (which was at least
// visible editorial output someone could catch). Tune after checking a few
// days of real `~semantic:<score>` values in matchedKeyword.
const SIMILARITY_THRESHOLD = 0.84;

/**
 * Second-pass, non-deterministic tagging: for posts the alias match in
 * match.ts didn't catch, compares the post title's embedding against each
 * trend's embedding (name + aliases, as a synthetic description) and tags
 * it if the best match clears SIMILARITY_THRESHOLD. Exists to catch press
 * coverage that describes a trend without using its dev-jargon aliases —
 * see taxonomy.yaml's "press phrasing" note.
 *
 * Mentions created this way are marked `~semantic:<score>` in
 * matchedKeyword instead of a literal alias, so they stay auditable and
 * separable from exact keyword matches.
 *
 * Needs VOYAGE_API_KEY — skips (doesn't throw) if it's not set, so `tag`
 * still runs with zero credentials same as before, just without this pass.
 * Also skips (doesn't throw) on any Voyage request failure — rate limits,
 * an outage, a missing billing method — same reasoning as the Reddit
 * connector's graceful skip: this pass is additive, and a provider hiccup
 * here must never block `aggregate`/`export` from running.
 */
export async function embedFallbackTag() {
  if (!process.env.VOYAGE_API_KEY) {
    return { postsScanned: 0, mentionsCreated: 0, skipped: "VOYAGE_API_KEY not set" };
  }

  const trendDefs = await prisma.trendDefinition.findMany();
  if (trendDefs.length === 0) return { postsScanned: 0, mentionsCreated: 0 };

  const posts = await prisma.rawPost.findMany({
    where: { mentions: { none: {} } },
    select: { id: true, title: true },
  });
  if (posts.length === 0) return { postsScanned: 0, mentionsCreated: 0 };

  let trendEmbeddings: number[][];
  let postEmbeddings: number[][];
  try {
    const trendTexts = trendDefs.map((t) => `${t.name}. ${(JSON.parse(t.aliases) as string[]).join(", ")}`);
    [trendEmbeddings, postEmbeddings] = await Promise.all([
      embedTexts(trendTexts),
      embedTexts(posts.map((p) => p.title)),
    ]);
  } catch (err) {
    return { postsScanned: 0, mentionsCreated: 0, skipped: `Voyage request failed: ${(err as Error).message}` };
  }

  let tagged = 0;
  for (let i = 0; i < posts.length; i++) {
    let bestTrend = -1;
    let bestScore = -1;
    for (let j = 0; j < trendDefs.length; j++) {
      const score = cosineSimilarity(postEmbeddings[i], trendEmbeddings[j]);
      if (score > bestScore) {
        bestScore = score;
        bestTrend = j;
      }
    }

    if (bestTrend === -1 || bestScore < SIMILARITY_THRESHOLD) continue;

    await prisma.postTrendMention.upsert({
      where: { postId_trendId: { postId: posts[i].id, trendId: trendDefs[bestTrend].id } },
      update: {},
      create: {
        postId: posts[i].id,
        trendId: trendDefs[bestTrend].id,
        matchedKeyword: `~semantic:${bestScore.toFixed(2)}`,
      },
    });
    tagged++;
  }

  return { postsScanned: posts.length, mentionsCreated: tagged };
}
