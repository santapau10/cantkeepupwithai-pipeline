// Powers the Toolbox's "Trending" selector on the main app — a curated set
// of 8 GitHub repos, fully replaced every run (see the trending stage in
// index.ts and the trending cron in .github/workflows/trending.yml).
//
// Deliberately separate from GitHubConnector (src/sources/github.ts), which
// keeps feeding the trend radar unchanged — same Search API + topic-query
// approach, but a different question ("what should the Toolbox curate as
// Trending right now" vs "what counts as a trend mention this run") and a
// different output shape (a Tool-shaped record, not a NormalizedPost).

type GitHubRepo = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
};

export type TrendingTool = {
  name: string;
  description: string;
  commandOrLink: string;
  repoUrl: string;
  repoStars: number;
  repoLanguage: string | null;
  field: string;
};

// Fixed topic -> Toolbox field mapping, in priority order: a repo that
// matches more than one topic's search query is assigned the field of
// whichever topic in this list matched first — no scoring, no LLM call.
const TOPIC_FIELD_MAP: [topic: string, field: string][] = [
  ["llm", "coding"],
  ["ai-agents", "agents"],
  ["mcp", "agents"],
  ["rag", "data"],
  ["llmops", "coding"],
];

// A few days, not GitHubConnector's 14 — "trending" means recently active,
// not just "created sometime in the last two weeks".
const TRENDING_WINDOW_DAYS = 3;
const TRENDING_COUNT = 8;

function headers(): HeadersInit {
  const h: HeadersInit = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

export async function fetchTrendingRepos(): Promise<TrendingTool[]> {
  const since = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Map keyed by repo id, first topic match wins (see TOPIC_FIELD_MAP note).
  const byId = new Map<number, { repo: GitHubRepo; field: string }>();
  let errorCount = 0;

  for (const [topic, field] of TOPIC_FIELD_MAP) {
    // `pushed:>since` (last push activity), not `created:>since` — a repo
    // that's months old but blew up in popularity this week should still
    // qualify as "trending"; a repo created 3 days ago with no activity
    // since shouldn't be favored just for being new.
    const q = encodeURIComponent(`topic:${topic} pushed:>${since}`);
    const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`;
    try {
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) {
        // Same rate-limit-tolerant behavior as GitHubConnector: skip this
        // topic rather than failing the whole run — but tallied below so a
        // total wipeout across every topic isn't silently treated as "0
        // legitimate candidates" (see errorCount check).
        console.warn(`Trending GitHub search failed for topic=${topic}: ${res.status}`);
        errorCount++;
        continue;
      }
      const data = (await res.json()) as { items: GitHubRepo[] };
      for (const repo of data.items) {
        if (!byId.has(repo.id)) byId.set(repo.id, { repo, field });
      }
    } catch (err) {
      console.warn(`Trending GitHub search threw for topic=${topic}:`, (err as Error).message);
      errorCount++;
    }
  }

  // Every single topic query failed (rate limit, expired/missing token,
  // network outage) — that's "the API had a bad day", not "there are
  // genuinely 0 trending repos right now". Throw so the caller
  // (exportTrendingForMainApp) skips the sync entirely and the previous
  // 3-day batch stays live, instead of wiping the Toolbox's Trending
  // section down to zero until the next scheduled run.
  if (errorCount === TOPIC_FIELD_MAP.length) {
    throw new Error(
      `All ${TOPIC_FIELD_MAP.length} trending topic searches failed — likely a GitHub API/rate-limit/auth issue, not a lack of candidates. Aborting to avoid wiping the existing Trending batch.`,
    );
  }

  return [...byId.values()]
    .sort((a, b) => b.repo.stargazers_count - a.repo.stargazers_count)
    .slice(0, TRENDING_COUNT)
    .map(({ repo, field }) => ({
      name: repo.full_name,
      // Fall back to a non-empty description — the backend's create-tool
      // validation treats "" the same as missing and would drop an
      // otherwise-valid top-8-by-stars candidate just for lacking a GitHub
      // description (same style of fallback as the webapp backend's
      // fetch-repo preview for manual submits, tools.ts).
      description: repo.description ?? `${repo.full_name} on GitHub`,
      commandOrLink: repo.html_url,
      repoUrl: repo.html_url,
      repoStars: repo.stargazers_count,
      repoLanguage: repo.language,
      field,
    }));
}
