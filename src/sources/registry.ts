import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { HackerNewsConnector } from "./hn.js";
import { GitHubConnector } from "./github.js";
import { RedditConnector } from "./reddit.js";
import { RssConnector } from "./rss.js";
import { XConnector } from "./x.js";
import { YouTubeConnector } from "./youtube.js";
import type { SourceConnector } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcesYamlPath = path.join(here, "../config/sources.yaml");

type FeedEntry = { name: string; url: string };

type SourcesConfig = {
  reddit: string[];
  x_accounts: string[];
  x_rotation_groups?: number;
  rss_community: FeedEntry[];
  rss_news: FeedEntry[];
};

export function loadSourcesConfig(): SourcesConfig {
  const raw = readFileSync(sourcesYamlPath, "utf8");
  return yaml.load(raw) as SourcesConfig;
}

/**
 * Splits `accounts` into `groups` round-robin buckets and returns the one
 * whose turn it is today, so a fixed rotation covers everyone every
 * `groups` days instead of polling (and paying for) all of them daily.
 * Days-since-epoch, not day-of-month, so the rotation doesn't skip/repeat
 * a bucket at month boundaries.
 */
function todaysRotation<T>(accounts: T[], groups: number): T[] {
  if (groups <= 1) return accounts;
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000);
  const turn = daysSinceEpoch % groups;
  return accounts.filter((_, i) => i % groups === turn);
}

/** Every source the pipeline knows how to read from, HN/GitHub included. */
export function buildConnectors(): SourceConnector[] {
  const config = loadSourcesConfig();
  const connectors: SourceConnector[] = [new HackerNewsConnector(), new GitHubConnector(), new YouTubeConnector()];

  for (const subreddit of config.reddit) {
    connectors.push(new RedditConnector(subreddit));
  }
  const todaysXAccounts = todaysRotation(config.x_accounts, config.x_rotation_groups ?? 1);
  for (const username of todaysXAccounts) {
    connectors.push(new XConnector(username, todaysXAccounts));
  }
  for (const feed of config.rss_community) {
    connectors.push(new RssConnector(feed.name, feed.url, "community"));
  }
  for (const feed of config.rss_news) {
    connectors.push(new RssConnector(feed.name, feed.url, "news"));
  }

  return connectors;
}
