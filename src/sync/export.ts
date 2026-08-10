import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { computeTrendSnapshots } from "../aggregate/snapshot.js";
import { translateTitles } from "../taxonomy/translate.js";
import { generateTrendContext } from "../synthesize/context.js";
import { fetchTrendingRepos, type TrendingTool } from "../sources/trending.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, "../../data/export");

// Two separate caps, one per selection criterion — the final reference set is
// the deduplicated union of "top by score" and "top by recency", so a trend
// can end up with anywhere from REFERENCES_PER_CRITERION (full overlap) up to
// 2 * REFERENCES_PER_CRITERION (no overlap) references.
const REFERENCES_PER_CRITERION = 5;
// Applied after the union above, so one source can't fill the whole
// reference list on its own — YouTube's score is view count, which dwarfs
// GitHub stars/HN points/upvotes, so an uncapped "top by score" pass lets it
// crowd out every other source once it's ingesting daily.
const MAX_REFERENCES_PER_SOURCE = 3;

type SyncPayload = {
  trends: {
    name: string;
    tag: string;
    pctChangeWeek: number;
    history: { day: string; mentions: number }[];
    references: { sourceName: string; title: string; url: string; postedAt: string; snippet?: string | null; upvotes?: number | null }[];
    summary?: string;
    whyItMatters?: string;
  }[];
  pipelineRun: { sourcesChecked: number; postsRead: number };
};

/**
 * Generate-once-cache-forever: reads TrendDefinition.summary/whyItMatters,
 * and only calls the model when either is still missing — most daily runs
 * this is just the findUnique, no model call. Sample titles come from the
 * references already built for this trend (translated, so always English)
 * rather than a separate query. Returns undefined fields (not a thrown
 * error) when generation isn't possible yet (no API key, no references),
 * so a sync never regresses a previously-cached value — see SyncTrend's
 * conditional-update handling on the receiving end.
 */
async function ensureTrendContext(trendName: string, tag: string, sampleTitles: string[]) {
  const def = await prisma.trendDefinition.findUnique({ where: { name: trendName } });
  if (def?.summary && def?.whyItMatters) {
    return { summary: def.summary, whyItMatters: def.whyItMatters };
  }

  const generated = await generateTrendContext(trendName, tag, sampleTitles);
  if (!generated) {
    return { summary: def?.summary ?? undefined, whyItMatters: def?.whyItMatters ?? undefined };
  }

  if (def) {
    await prisma.trendDefinition.update({
      where: { id: def.id },
      data: { summary: generated.summary, whyItMatters: generated.whyItMatters },
    });
  }
  return generated;
}

async function buildReferences(trendName: string) {
  const where = { trend: { name: trendName } };
  const include = { post: { include: { source: true } } } as const;

  const [byScore, byDate] = await Promise.all([
    prisma.postTrendMention.findMany({
      where,
      include,
      orderBy: { post: { score: "desc" } },
      take: REFERENCES_PER_CRITERION,
    }),
    prisma.postTrendMention.findMany({
      where,
      include,
      orderBy: { post: { postedAt: "desc" } },
      take: REFERENCES_PER_CRITERION,
    }),
  ]);

  // Union of both sets, deduped by post id — a post that ranks in both the
  // top-by-score and top-by-date cuts should only appear once. Also capped
  // per source (MAX_REFERENCES_PER_SOURCE) as it's built: byScore comes
  // first, so a source's highest-scoring posts fill its quota before
  // byDate gets a chance to add more from the same source — a source that
  // hits its cap on score alone doesn't get to double-dip on recency too.
  const seen = new Set<string>();
  const perSourceCount = new Map<string, number>();
  const mentions = [];
  for (const m of [...byScore, ...byDate]) {
    if (seen.has(m.post.id)) continue;
    const sourceName = m.post.source.name;
    const count = perSourceCount.get(sourceName) ?? 0;
    if (count >= MAX_REFERENCES_PER_SOURCE) continue;
    seen.add(m.post.id);
    perSourceCount.set(sourceName, count + 1);
    mentions.push(m);
  }

  // Translate display title + snippet for only this trend's ~10 shown
  // references, not the whole ingested backlog — and only the ones not
  // already cached from a previous day's export (see
  // RawPost.titleTranslated/snippetTranslated). Title and snippet go in one
  // batched call together, not two separate ones, to halve the model calls.
  const untranslated = mentions.filter(
    (m) => m.post.titleTranslated === null || (m.post.snippet !== null && m.post.snippetTranslated === null),
  );
  if (untranslated.length > 0) {
    const titles = untranslated.map((m) => m.post.title);
    const snippetIndices: number[] = [];
    const snippets: string[] = [];
    untranslated.forEach((m, i) => {
      if (m.post.snippet) {
        snippetIndices.push(i);
        snippets.push(m.post.snippet);
      }
    });

    const translated = await translateTitles([...titles, ...snippets]);
    const translatedTitles = translated.slice(0, titles.length);
    const translatedSnippets = translated.slice(titles.length);

    const snippetByIndex = new Map(snippetIndices.map((origIndex, j) => [origIndex, translatedSnippets[j]]));

    await Promise.all(
      untranslated.map((m, i) =>
        prisma.rawPost.update({
          where: { id: m.post.id },
          data: { titleTranslated: translatedTitles[i], snippetTranslated: snippetByIndex.get(i) ?? null },
        }),
      ),
    );
    untranslated.forEach((m, i) => {
      m.post.titleTranslated = translatedTitles[i];
      m.post.snippetTranslated = snippetByIndex.get(i) ?? null;
    });
  }

  return mentions.map((m) => ({
    sourceName: m.post.source.name,
    title: m.post.titleTranslated ?? m.post.title,
    url: m.post.url,
    postedAt: m.post.postedAt.toISOString(),
    snippet: m.post.snippetTranslated ?? m.post.snippet,
    upvotes: m.post.score || null,
  }));
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
    snapshots.map(async (s) => {
      const references = await buildReferences(s.trendName);
      const context = await ensureTrendContext(s.trendName, s.tag, references.map((r) => r.title));
      return {
        name: s.trendName,
        tag: s.tag,
        pctChangeWeek: s.pctChangeWeek,
        history: s.history.map((h) => ({ day: h.day, mentions: h.mentions })),
        references,
        summary: context.summary,
        whyItMatters: context.whyItMatters,
      };
    }),
  );

  const [sourcesChecked, postsRead] = await Promise.all([
    prisma.source.count({ where: { enabled: true } }),
    prisma.rawPost.count(),
  ]);

  const payload: SyncPayload = {
    trends,
    pipelineRun: { sourcesChecked, postsRead },
  };

  const today = new Date().toISOString().slice(0, 10);
  const payloadPath = path.join(exportDir, `sync-${today}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  const syncUrl = process.env.WEB_SYNC_URL;
  const syncKey = process.env.WEB_SYNC_API_KEY;
  if (!syncUrl || !syncKey) {
    return { payloadPath, trendCount: trends.length, synced: false, reason: "WEB_SYNC_URL/WEB_SYNC_API_KEY not set" };
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
  return { payloadPath, trendCount: trends.length, synced: true, result };
}

/**
 * Separate sync path for the Toolbox's "Trending" selector — run every 3
 * days by its own cron (.github/workflows/trending.yml), independent of the
 * daily trends/digest export above. Posts just `{ trendingTools }` to the
 * same POST /api/pipeline/sync endpoint; the backend replaces its whole
 * sourceType="trending" batch with whatever's sent here (see
 * backend/src/routes/pipeline.ts) — no `trends`/`pipelineRun` in this
 * payload, so it doesn't touch trend data or overwrite the daily ingest
 * stats shown on the homepage ticker.
 */
export async function exportTrendingForMainApp() {
  mkdirSync(exportDir, { recursive: true });

  const trendingTools = await fetchTrendingRepos();

  const payload: { trendingTools: TrendingTool[] } = { trendingTools };

  const today = new Date().toISOString().slice(0, 10);
  const payloadPath = path.join(exportDir, `trending-${today}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  const syncUrl = process.env.WEB_SYNC_URL;
  const syncKey = process.env.WEB_SYNC_API_KEY;
  if (!syncUrl || !syncKey) {
    return { payloadPath, toolCount: trendingTools.length, synced: false, reason: "WEB_SYNC_URL/WEB_SYNC_API_KEY not set" };
  }

  const res = await fetch(`${syncUrl}/api/pipeline/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncKey}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trending sync POST to ${syncUrl} failed: ${res.status} ${body}`);
  }

  const result = await res.json();
  return { payloadPath, toolCount: trendingTools.length, synced: true, result };
}
