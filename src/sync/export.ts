import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { computeTrendSnapshots } from "../aggregate/snapshot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, "../../data/export");

const REFERENCES_PER_TREND = 5;

type SyncPayload = {
  trends: {
    name: string;
    tag: string;
    pctChangeWeek: number;
    history: { day: string; mentions: number }[];
    references: { sourceName: string; title: string; url: string; postedAt: string; snippet?: string | null; upvotes?: number | null }[];
  }[];
  digest: { issueDate: string; stories: { headline: string; summary: string; whyItMatters: string; sources: { sourceName: string; threadCount: number; url: string }[] }[] } | null;
  pipelineRun: { sourcesChecked: number; postsRead: number; storiesProduced: number; readingMinutesSaved: number };
};

async function buildReferences(trendName: string) {
  const mentions = await prisma.postTrendMention.findMany({
    where: { trend: { name: trendName } },
    include: { post: { include: { source: true } } },
    orderBy: { post: { score: "desc" } },
    take: REFERENCES_PER_TREND,
  });

  return mentions.map((m) => ({
    sourceName: m.post.source.name,
    title: m.post.title,
    url: m.post.url,
    postedAt: m.post.postedAt.toISOString(),
    upvotes: m.post.score || null,
  }));
}

async function buildDigest(forDate: Date) {
  const start = new Date(forDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const stories = await prisma.storyDraft.findMany({
    where: { status: "approved", digestDate: { gte: start, lt: end } },
  });

  if (stories.length === 0) return null;

  const digestStories = await Promise.all(
    stories.map(async (s) => {
      const postIds: string[] = JSON.parse(s.sourcePostIds);
      const posts = postIds.length
        ? await prisma.rawPost.findMany({ where: { id: { in: postIds } }, include: { source: true } })
        : [];
      return {
        headline: s.headline,
        summary: s.summary,
        whyItMatters: s.whyItMatters,
        sources: posts.map((p) => ({ sourceName: p.source.name, threadCount: p.commentCount, url: p.url })),
      };
    }),
  );

  return { issueDate: start.toISOString().slice(0, 10), stories: digestStories };
}

/**
 * Builds the sync payload and POSTs it to the main app's
 * POST /api/pipeline/sync (see WEB_SYNC_URL/WEB_SYNC_API_KEY in .env). Also
 * still writes the JSON locally under data/export/ — cheap, and useful for
 * debugging a run without needing the web app up.
 */
export async function exportForMainApp() {
  mkdirSync(exportDir, { recursive: true });

  const snapshots = await computeTrendSnapshots();
  const trends = await Promise.all(
    snapshots.map(async (s) => ({
      name: s.trendName,
      tag: s.tag,
      pctChangeWeek: s.pctChangeWeek,
      history: s.history.map((h) => ({ day: h.day, mentions: h.mentions })),
      references: await buildReferences(s.trendName),
    })),
  );

  const digest = await buildDigest(new Date());

  const [sourcesChecked, postsRead] = await Promise.all([
    prisma.source.count({ where: { enabled: true } }),
    prisma.rawPost.count(),
  ]);

  const payload: SyncPayload = {
    trends,
    digest,
    pipelineRun: {
      sourcesChecked,
      postsRead,
      storiesProduced: digest?.stories.length ?? 0,
      readingMinutesSaved: (digest?.stories.length ?? 0) * 4,
    },
  };

  const today = new Date().toISOString().slice(0, 10);
  const payloadPath = path.join(exportDir, `sync-${today}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  const syncUrl = process.env.WEB_SYNC_URL;
  const syncKey = process.env.WEB_SYNC_API_KEY;
  if (!syncUrl || !syncKey) {
    return { payloadPath, trendCount: trends.length, storyCount: digest?.stories.length ?? 0, synced: false, reason: "WEB_SYNC_URL/WEB_SYNC_API_KEY not set" };
  }

  const res = await fetch(`${syncUrl}/api/pipeline/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncKey}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sync POST to ${syncUrl} failed: ${res.status} ${body}`);
  }

  const result = await res.json();
  return { payloadPath, trendCount: trends.length, storyCount: digest?.stories.length ?? 0, synced: true, result };
}
