import Parser from "rss-parser";
import type { NormalizedPost, SourceConnector, SourceKind } from "./types.js";
import { truncateSnippet } from "./types.js";

const parser = new Parser();

export class RssConnector implements SourceConnector {
  type = "rss";

  constructor(
    public name: string,
    private feedUrl: string,
    public kind: SourceKind = "community",
  ) {}

  async fetchRecent(): Promise<NormalizedPost[]> {
    const feed = await parser.parseURL(this.feedUrl);
    return (feed.items ?? [])
      .filter((item) => item.link && item.title)
      .map((item) => ({
        externalId: item.guid ?? item.link!,
        title: item.title!,
        url: item.link!,
        // rss-parser already strips HTML/truncates this to plain text — a
        // free real excerpt most feeds provide, previously just discarded.
        snippet: truncateSnippet(item.contentSnippet),
        author: item.creator ?? item.author,
        score: 0,
        commentCount: 0,
        postedAt: item.isoDate ? new Date(item.isoDate) : new Date(),
      }));
  }
}
