import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { prisma } from "../lib/prisma.js";
import { embedFallbackTag } from "./semanticMatch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const taxonomyYamlPath = path.join(here, "../config/taxonomy.yaml");

type TaxonomyEntry = { name: string; tag: string; aliases: string[] };
type TaxonomyConfig = { trends: TaxonomyEntry[] };

export function loadTaxonomy(): TaxonomyEntry[] {
  const raw = readFileSync(taxonomyYamlPath, "utf8");
  return (yaml.load(raw) as TaxonomyConfig).trends;
}

/** Mirrors taxonomy.yaml into TrendDefinition rows — the YAML stays the source of truth. */
export async function syncTaxonomy() {
  const trends = loadTaxonomy();
  for (const trend of trends) {
    await prisma.trendDefinition.upsert({
      where: { name: trend.name },
      update: { tag: trend.tag, aliases: JSON.stringify(trend.aliases) },
      create: { name: trend.name, tag: trend.tag, aliases: JSON.stringify(trend.aliases) },
    });
  }
  return trends.length;
}

/**
 * Deterministic keyword tagging: case-insensitive substring match of each
 * trend's aliases against the post title. No model call — this is what
 * feeds the mention counts.
 */
async function keywordTag() {
  const trendDefs = await prisma.trendDefinition.findMany();
  const compiled = trendDefs.map((t) => ({
    id: t.id,
    aliases: (JSON.parse(t.aliases) as string[]).map((a) => a.toLowerCase()),
  }));

  const posts = await prisma.rawPost.findMany({
    where: { mentions: { none: {} } },
    select: { id: true, title: true },
  });

  let tagged = 0;
  for (const post of posts) {
    const titleLower = post.title.toLowerCase();
    for (const trend of compiled) {
      const matched = trend.aliases.find((alias) => titleLower.includes(alias));
      if (!matched) continue;
      await prisma.postTrendMention.upsert({
        where: { postId_trendId: { postId: post.id, trendId: trend.id } },
        update: {},
        create: { postId: post.id, trendId: trend.id, matchedKeyword: matched },
      });
      tagged++;
    }
  }

  return { postsScanned: posts.length, mentionsCreated: tagged };
}

/**
 * Full `tag` stage: deterministic alias matching first, then an embedding
 * fallback pass (see semanticMatch.ts) over whatever's still untagged —
 * catches press coverage that describes a trend without using its dev
 * jargon aliases.
 */
export async function tagUntaggedPosts() {
  await syncTaxonomy();

  const keyword = await keywordTag();
  const semantic = await embedFallbackTag();

  return {
    postsScanned: keyword.postsScanned,
    mentionsCreated: keyword.mentionsCreated + semantic.mentionsCreated,
    keyword,
    semantic,
  };
}
