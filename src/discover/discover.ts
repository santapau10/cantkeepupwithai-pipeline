import { prisma } from "../lib/prisma.js";
import { embedTexts } from "./embed.js";
import { greedyCluster } from "./cluster.js";
import { labelCluster } from "./label.js";
import { loadTaxonomy } from "../taxonomy/match.js";
import { findLikelyDuplicate, type TrendLike } from "../taxonomy/similarity.js";

const MIN_CLUSTER_SIZE = 3; // below this, almost always noise, not a trend
// Lowered from 0.82 after checking real pairs on 2026-08-07: near-duplicate
// coverage of the same event scored 0.87-0.92, but some legitimate
// same-topic-different-wording pairs (e.g. two posts both about model
// routing, phrased very differently) sat around 0.73-0.76 and never had a
// chance to reach MIN_CLUSTER_SIZE. Most of the noise in that range turned
// out to be link-only X posts (see x.ts's hasMeaningfulText filter), not a
// reason to keep the threshold high.
const SIMILARITY_THRESHOLD = 0.75;
const MAX_SAMPLE_TITLES = 15; // capped context sent to the labeling call
const MAX_SAMPLE_POST_IDS = 10; // capped for the human reviewer

/**
 * Weekly, not daily: catches topics the taxonomy doesn't have aliases for
 * yet. Two model calls per run — one embedding batch, one Haiku label per
 * qualifying cluster — everything else (which posts group together) is
 * the same deterministic clustering math either way.
 */
export async function discoverNewTrends() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // All sources, community and news alike — matches aggregate/snapshot.ts's
  // "everything feeds the trend radar" behavior since Digest was removed.
  // Kept community-only until then to keep genuinely vague press coverage
  // out of clustering; MIN_CLUSTER_SIZE + labelCluster's skepticism are now
  // what's expected to filter that noise instead.
  const untagged = await prisma.rawPost.findMany({
    where: { postedAt: { gte: since }, mentions: { none: {} } },
    select: { id: true, title: true },
  });

  if (untagged.length === 0) {
    return { untaggedPosts: 0, clustersFound: 0, candidatesCreated: 0 };
  }

  const embeddings = await embedTexts(untagged.map((p) => p.title));
  const clusters = greedyCluster(
    untagged.map((p, i) => ({ id: p.id, embedding: embeddings[i] })),
    SIMILARITY_THRESHOLD,
  ).filter((c) => c.memberIds.length >= MIN_CLUSTER_SIZE);

  const titleById = new Map(untagged.map((p) => [p.id, p.title]));
  let candidatesCreated = 0;
  let duplicatesSkipped = 0;

  // What to check every new cluster against: the taxonomy as it stands
  // today, any candidate still awaiting review from a previous run (its
  // posts are still untagged, so the same topic can easily re-cluster
  // before anyone's approved/rejected it), and whatever this run has
  // already proposed (greedy clustering can split one real trend into two
  // clusters — this catches that case name/alias comparison couldn't
  // before at either point, not just at apply time).
  const existingTaxonomy: TrendLike[] = loadTaxonomy().map((t) => ({ name: t.name, aliases: t.aliases }));
  const stillPending = await prisma.clusterCandidate.findMany({
    where: { status: "pending" },
    select: { suggestedName: true, suggestedAliases: true },
  });
  const knownTrends: TrendLike[] = [
    ...existingTaxonomy,
    ...stillPending.map((c) => ({ name: c.suggestedName, aliases: JSON.parse(c.suggestedAliases || "[]") as string[] })),
  ];

  for (const cluster of clusters) {
    const sampleIds = cluster.memberIds.slice(0, MAX_SAMPLE_POST_IDS);
    const sampleTitles = cluster.memberIds.slice(0, MAX_SAMPLE_TITLES).map((id) => titleById.get(id)!);

    const label = await labelCluster(sampleTitles);
    if (!label.isRealTrend) continue;

    const dup = findLikelyDuplicate(label.suggestedName, label.suggestedAliases, knownTrends);
    if (dup) {
      console.log(`Skipping "${label.suggestedName}" — ${dup.reason}`);
      duplicatesSkipped++;
      continue;
    }

    await prisma.clusterCandidate.create({
      data: {
        samplePostIds: JSON.stringify(sampleIds),
        suggestedName: label.suggestedName,
        suggestedTag: label.suggestedTag,
        suggestedAliases: JSON.stringify(label.suggestedAliases),
        rationale: label.rationale,
        clusterSize: cluster.memberIds.length,
        status: "pending",
      },
    });
    candidatesCreated++;
    // So a later cluster in the same run that turns out to be the same
    // trend (split by the greedy clustering) gets caught too, not just
    // duplicates of what existed before this run started.
    knownTrends.push({ name: label.suggestedName, aliases: label.suggestedAliases });
  }

  return { untaggedPosts: untagged.length, clustersFound: clusters.length, candidatesCreated, duplicatesSkipped };
}

/** For the human review step — prints pending candidates for someone to approve/reject. */
export async function listPendingCandidates() {
  return prisma.clusterCandidate.findMany({ where: { status: "pending" }, orderBy: { clusterSize: "desc" } });
}
