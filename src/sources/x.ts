import type { NormalizedPost, SourceConnector } from "./types.js";

type XUser = { id: string; username: string };

type XTweet = {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: { like_count: number; reply_count: number };
};

// Resolved once per process run and shared across every XConnector instance —
// GET /2/users/by batches up to 100 usernames per call, so 20 tracked
// accounts cost one $0.01×20 lookup instead of twenty separate ones.
let userIdCache: Map<string, string> | null = null;

async function resolveUserIds(usernames: string[], token: string): Promise<Map<string, string>> {
  if (userIdCache) return userIdCache;

  const map = new Map<string, string>();
  for (let i = 0; i < usernames.length; i += 100) {
    const batch = usernames.slice(i, i + 100);
    const res = await fetch(`https://api.x.com/2/users/by?usernames=${batch.join(",")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`X user lookup failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data?: XUser[] };
    for (const u of json.data ?? []) map.set(u.username.toLowerCase(), u.id);
  }

  userIdCache = map;
  return map;
}

/**
 * One instance per tracked account — matches the "one Source row per
 * subreddit" shape RedditConnector uses. Pay-per-use: ~$0.005/post read,
 * $0.01/user lookup (see README § Sources).
 */
export class XConnector implements SourceConnector {
  type = "x";
  kind = "community" as const;

  constructor(
    public username: string,
    private allUsernames: string[],
  ) {}

  get name() {
    return `@${this.username}`;
  }

  async fetchRecent(): Promise<NormalizedPost[]> {
    const token = process.env.X_BEARER_TOKEN;
    if (!token) {
      throw new Error(
        "X connector needs X_BEARER_TOKEN (Bearer token from a Pay-Per-Use app at " +
          "https://developer.x.com). Not set — skipping.",
      );
    }

    const ids = await resolveUserIds(this.allUsernames, token);
    const userId = ids.get(this.username.toLowerCase());
    if (!userId) throw new Error(`X user lookup returned no match for @${this.username}`);

    // max_results=5 is the API floor — can't request fewer per account.
    const res = await fetch(
      `https://api.x.com/2/users/${userId}/tweets` +
        "?max_results=5&exclude=retweets,replies&tweet.fields=created_at,public_metrics",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`X fetch failed for @${this.username}: ${res.status} ${res.statusText}`);

    const json = (await res.json()) as { data?: XTweet[] };
    return (json.data ?? []).map((t) => ({
      externalId: t.id,
      title: t.text,
      url: `https://x.com/${this.username}/status/${t.id}`,
      author: this.username,
      score: t.public_metrics?.like_count ?? 0,
      commentCount: t.public_metrics?.reply_count ?? 0,
      postedAt: new Date(t.created_at),
    }));
  }
}
