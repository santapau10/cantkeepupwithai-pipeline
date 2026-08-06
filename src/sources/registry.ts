import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { HackerNewsConnector } from "./hn.js";
import { GitHubConnector } from "./github.js";
import { RedditConnector } from "./reddit.js";
import { RssConnector } from "./rss.js";
import type { SourceConnector } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcesYamlPath = path.join(here, "../config/sources.yaml");

type SourcesConfig = {
  reddit: string[];
  rss: { name: string; url: string }[];
};

export function loadSourcesConfig(): SourcesConfig {
  const raw = readFileSync(sourcesYamlPath, "utf8");
  return yaml.load(raw) as SourcesConfig;
}

/** Every source the pipeline knows how to read from, HN/GitHub included. */
export function buildConnectors(): SourceConnector[] {
  const config = loadSourcesConfig();
  const connectors: SourceConnector[] = [new HackerNewsConnector(), new GitHubConnector()];

  for (const subreddit of config.reddit) {
    connectors.push(new RedditConnector(subreddit));
  }
  for (const feed of config.rss) {
    connectors.push(new RssConnector(feed.name, feed.url));
  }

  return connectors;
}
