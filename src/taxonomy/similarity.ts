// Shared duplicate-detection logic — used by discover.ts (skip a cluster
// that's really the same trend as one already proposed this run, or
// already in the taxonomy) and applyCandidate.ts (refuse to write a
// near-duplicate at apply time). Exact-name matching alone missed real
// duplicates whenever a human renamed the suggested name during review
// (e.g. "Agent memory systems & persistence" vs a hand-shortened "Agent
// memory & persistence") — this catches that by also comparing aliases and
// significant-word overlap in the name, not just an exact string match.

const STOPWORDS = new Set(["ai", "a", "an", "the", "and", "or", "for", "with", "in", "of", "to", "on", "&"]);

function significantWords(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity over significant (non-stopword) words in each name. */
export function nameSimilarity(a: string, b: string): number {
  const wa = significantWords(a);
  const wb = significantWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return intersection / union;
}

export type TrendLike = { name: string; aliases: string[] };

const NAME_SIMILARITY_THRESHOLD = 0.5;

/**
 * Returns the first existing/other-candidate trend this one looks like a
 * duplicate of, or null if it looks distinct. Two signals, either one is
 * enough to flag it:
 *  - exact alias collision (case-insensitive) — the strongest signal, since
 *    aliases are meant to be specific
 *  - name similarity >= NAME_SIMILARITY_THRESHOLD (Jaccard over significant
 *    words) — catches renames/rewording of the same underlying trend
 */
export function findLikelyDuplicate(
  candidateName: string,
  candidateAliases: string[],
  against: TrendLike[],
): { match: TrendLike; reason: string } | null {
  const candAliasSet = new Set(candidateAliases.map((a) => a.toLowerCase()));

  for (const t of against) {
    const collidingAlias = t.aliases.find((a) => candAliasSet.has(a.toLowerCase()));
    if (collidingAlias) {
      return { match: t, reason: `shares alias "${collidingAlias}" with "${t.name}"` };
    }

    const sim = nameSimilarity(candidateName, t.name);
    if (sim >= NAME_SIMILARITY_THRESHOLD) {
      return { match: t, reason: `name is ${Math.round(sim * 100)}% similar (by shared words) to "${t.name}"` };
    }
  }

  return null;
}
