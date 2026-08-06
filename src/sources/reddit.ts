import type { NormalizedPost, SourceConnector } from "./types.js";

type RedditListing = {
  data: {
    children: {
      data: {
        id: string;
        title: string;
        url: string;
        permalink: string;
        author: string;
        score: number;
        num_comments: number;
        created_utc: number;
      };
    }[];
  };
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) {
    throw new Error(
      "Reddit connector needs REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT " +
        "(create a 'script' app at https://www.reddit.com/prefs/apps). Not set — skipping.",
    );
  }

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status} ${res.statusText}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cachedToken.token;
}

/** One instance per subreddit — matches the "one Source row per subreddit" shape in sources.yaml. */
export class RedditConnector implements SourceConnector {
  type = "reddit";
  kind = "community" as const;

  constructor(public subreddit: string) {}

  get name() {
    return `r/${this.subreddit}`;
  }

  async fetchRecent(): Promise<NormalizedPost[]> {
    const token = await getAccessToken();
    const userAgent = process.env.REDDIT_USER_AGENT!;

    const res = await fetch(`https://oauth.reddit.com/r/${this.subreddit}/hot?limit=50`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
    });
    if (!res.ok) throw new Error(`Reddit fetch failed for r/${this.subreddit}: ${res.status}`);

    const listing = (await res.json()) as RedditListing;
    return listing.data.children.map(({ data: post }) => ({
      externalId: post.id,
      title: post.title,
      url: post.url.startsWith("http") ? post.url : `https://reddit.com${post.permalink}`,
      author: post.author,
      score: post.score,
      commentCount: post.num_comments,
      postedAt: new Date(post.created_utc * 1000),
    }));
  }
}
