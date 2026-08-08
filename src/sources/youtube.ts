import type { NormalizedPost, SourceConnector } from "./types.js";

type YouTubeSearchItem = {
  id: { videoId: string };
  snippet: {
    title: string;
    channelTitle: string;
    publishedAt: string;
  };
};

type YouTubeVideoStats = {
  id: string;
  statistics?: { viewCount?: string; commentCount?: string };
};

// search.list costs 100 units/query against the 10,000 units/day free quota
// (see README). Kept to a handful of queries, same shape as GitHub's
// TOPICS — 5 * 100 = 500/day, well under quota.
const QUERIES = ["AI agent", "MCP server", "coding agent", "RAG pipeline", "LLM agent"];

// Excludes Shorts (<4min) — empirically the dominant source of clickbait/
// influencer noise in these queries, not the kind of coverage the taxonomy
// aliases are trying to catch. Two durations instead of just "medium" so
// long-form content (talks, deep dives) still gets in — doubles the search
// cost to ~1,000/day, still well under quota.
const DURATIONS = ["medium", "long"] as const;

const WINDOW_DAYS = 14; // matches GitHubConnector's window

export class YouTubeConnector implements SourceConnector {
  type = "youtube";
  name = "YouTube";
  kind = "community" as const;

  async fetchRecent(): Promise<NormalizedPost[]> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "YouTube connector needs YOUTUBE_API_KEY (free API key from Google Cloud Console, " +
          "with the YouTube Data API v3 enabled). Not set — skipping.",
      );
    }

    const publishedAfter = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const byId = new Map<string, YouTubeSearchItem>();

    for (const q of QUERIES) {
      for (const videoDuration of DURATIONS) {
        const url =
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date` +
          `&videoDuration=${videoDuration}&maxResults=25&publishedAfter=${publishedAfter}` +
          `&q=${encodeURIComponent(q)}&key=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) {
          // Rate limit / quota exhausted hits here first — skip this query
          // rather than failing the whole connector, same pattern as
          // GitHubConnector's per-topic try.
          console.warn(`YouTube search failed for q="${q}" duration=${videoDuration}: ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { items: YouTubeSearchItem[] };
        for (const item of data.items) byId.set(item.id.videoId, item);
      }
    }

    if (byId.size === 0) return [];

    const stats = await this.fetchStats([...byId.keys()], apiKey);

    return [...byId.values()].map((item) => ({
      externalId: item.id.videoId,
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      author: item.snippet.channelTitle,
      score: Number(stats.get(item.id.videoId)?.viewCount ?? 0),
      commentCount: Number(stats.get(item.id.videoId)?.commentCount ?? 0),
      postedAt: new Date(item.snippet.publishedAt),
    }));
  }

  // videos.list costs 1 unit per call no matter how many of the up-to-50 ids
  // are batched in — folds view/comment counts in for ~free next to the
  // 100-unit search calls above.
  private async fetchStats(ids: string[], apiKey: string) {
    const map = new Map<string, { viewCount?: string; commentCount?: string }>();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.join(",")}&key=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as { items: YouTubeVideoStats[] };
      for (const v of data.items) map.set(v.id, v.statistics ?? {});
    }
    return map;
  }
}
