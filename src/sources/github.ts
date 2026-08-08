import type { FetchOptions, NormalizedPost, SourceConnector } from "./types.js";

type GitHubRepo = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  owner: { login: string };
  stargazers_count: number;
  open_issues_count: number;
  created_at: string;
};

// Official Search API instead of scraping the (unofficial, no-API) Trending
// page. Multiple topic queries because GitHub's search syntax ANDs repeated
// `topic:` qualifiers rather than OR-ing them.
const TOPICS = ["llm", "ai-agents", "mcp", "rag", "llmops"];

export class GitHubConnector implements SourceConnector {
  type = "github";
  name = "GitHub";
  kind = "community" as const;

  private headers(): HeadersInit {
    const headers: HeadersInit = { Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    return headers;
  }

  async fetchRecent(options?: FetchOptions): Promise<NormalizedPost[]> {
    // per_page=20 below caps results to the top 20 by stars per topic no
    // matter how wide this window is, so a backfill just changes which repos
    // qualify — no pagination/volume concern like HN's.
    const since = new Date(Date.now() - (options?.days ?? 14) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const byId = new Map<number, GitHubRepo>();

    for (const topic of TOPICS) {
      const q = encodeURIComponent(`topic:${topic} created:>${since}`);
      const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        // Rate limits (60/hr unauthenticated) hit here first — skip this
        // topic rather than failing the whole connector.
        console.warn(`GitHub search failed for topic=${topic}: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { items: GitHubRepo[] };
      for (const repo of data.items) byId.set(repo.id, repo);
    }

    return [...byId.values()].map((repo) => ({
      externalId: String(repo.id),
      title: repo.description ? `${repo.full_name} — ${repo.description}` : repo.full_name,
      url: repo.html_url,
      author: repo.owner.login,
      score: repo.stargazers_count,
      commentCount: repo.open_issues_count,
      postedAt: new Date(repo.created_at),
    }));
  }
}
