export type NormalizedPost = {
  externalId: string;
  title: string;
  url: string;
  author?: string;
  score: number;
  commentCount: number;
  postedAt: Date;
};

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
