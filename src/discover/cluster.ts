export type EmbeddedItem = { id: string; embedding: number[] };
export type Cluster = { memberIds: string[]; centroid: number[] };

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-pass clustering ("leader algorithm"): each item joins the
 * most similar existing cluster if it clears the threshold, otherwise
 * starts a new one. Not k-means — no need to know the number of clusters
 * up front, which fits "how many new trends showed up this week" (unknown
 * in advance) better than a fixed-k method.
 */
export function greedyCluster(items: EmbeddedItem[], threshold = 0.82): Cluster[] {
  const clusters: (Cluster & { count: number })[] = [];

  for (const item of items) {
    let best: (Cluster & { count: number }) | null = null;
    let bestSim = -1;
    for (const cluster of clusters) {
      const sim = cosineSimilarity(item.embedding, cluster.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = cluster;
      }
    }

    if (best && bestSim >= threshold) {
      best.memberIds.push(item.id);
      best.count += 1;
      // running mean update, avoids re-averaging the whole cluster each time
      best.centroid = best.centroid.map((v, i) => v + (item.embedding[i] - v) / best!.count);
    } else {
      clusters.push({ memberIds: [item.id], centroid: [...item.embedding], count: 1 });
    }
  }

  return clusters.map(({ memberIds, centroid }) => ({ memberIds, centroid }));
}
