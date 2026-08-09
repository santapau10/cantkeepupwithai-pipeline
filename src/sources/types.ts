export type NormalizedPost = {
  externalId: string;
  title: string;
  url: string;
  // Real excerpt, when the source API gives one for free — see RssConnector,
  // YouTubeConnector, GitHubConnector. Left undefined (not empty string) for
  // sources with no natural equivalent (HN, Reddit, X).
  snippet?: string;
  author?: string;
  score: number;
  commentCount: number;
  postedAt: Date;
};

// Applied wherever a source snippet is captured — some RSS feeds dump a
// full article into `contentSnippet`, which would otherwise bloat storage
// and blow well past the frontend's 2-line clamp for no benefit.
export const MAX_SNIPPET_LENGTH = 280;

export function truncateSnippet(text: string | undefined | null): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 1)}…` : trimmed;
}

export type SourceKind = "community" | "news";

/**
 * Passed by `backfill` (see src/index.ts) to widen a connector past its
 * normal daily-poll window. Absent on the daily path — every connector's
 * default behavior when `options` is undefined is unchanged from before
 * backfill existed. Connectors that can't honor a wider window (RSS — feeds
 * only expose what the publisher currently keeps in them) just ignore it.
 */
export type FetchOptions = { days?: number };

export interface SourceConnector {
  /** Matches Source.type in the DB, and the `type` key in sources.yaml. */
  type: string;
  /** Human label for this specific source instance, e.g. "r/LocalLLaMA". */
  name: string;
  /**
   * Metadata only — both kinds feed the trend radar the same way. See
   * README § "No more Digest — everything feeds the trend radar".
   */
  kind: SourceKind;
  fetchRecent(options?: FetchOptions): Promise<NormalizedPost[]>;
}
