import Parser from "rss-parser";
import type { NormalizedPost, SourceConnector } from "./types.js";

const parser = new Parser();

export class RssConnector implements SourceConnector {
  type = "rss";

  constructor(
    public name: string,
    private feedUrl: string,
  ) {}

  async fetchRecent(): Promise<NormalizedPost[]> {
    const feed = await parser.parseURL(this.feedUrl);
    return (feed.items ?? [])
      .filter((item) => item.link && item.title)
      .map((item) => ({
        externalId: item.guid ?? item.link!,
        title: item.title!,
        url: item.link!,
        author: item.creator ?? item.author,
        score: 0,
        commentCount: 0,
        postedAt: item.isoDate ? new Date(item.isoDate) : new Date(),
      }));
  }
}
