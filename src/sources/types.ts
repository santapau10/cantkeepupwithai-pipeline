export type NormalizedPost = {
  externalId: string;
  title: string;
  url: string;
  author?: string;
  score: number;
  commentCount: number;
  postedAt: Date;
};

export interface SourceConnector {
  /** Matches Source.type in the DB, and the `type` key in sources.yaml. */
  type: string;
  /** Human label for this specific source instance, e.g. "r/LocalLLaMA". */
  name: string;
  fetchRecent(): Promise<NormalizedPost[]>;
}
