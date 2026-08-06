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

export interface SourceConnector {
  /** Matches Source.type in the DB, and the `type` key in sources.yaml. */
  type: string;
  /** Human label for this specific source instance, e.g. "r/LocalLLaMA". */
  name: string;
  /**
   * "community" feeds the trend radar (mention counts); "news" feeds the
   * digest (story synthesis). See README § Trends vs digest sourcing.
   */
  kind: SourceKind;
  fetchRecent(): Promise<NormalizedPost[]>;
}
