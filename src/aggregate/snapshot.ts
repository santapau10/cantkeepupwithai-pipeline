import { prisma } from "../lib/prisma.js";

export type TrendSnapshotRow = {
  trendName: string;
  tag: string;
  day: string; // YYYY-MM-DD
  mentions: number;
};

export type TrendSummary = {
  trendName: string;
  tag: string;
  mentions: number; // most recent day
  pctChangeWeek: number;
  history: TrendSnapshotRow[];
};

/**
 * Pure aggregation — SQL/JS grouping over already-tagged mentions.
 * No model call: this is what feeds TrendSnapshot on the main app.
 *
 * All sources count equally now (community and news alike) — there is no
 * separate digest to keep news mentions out of anymore. In practice, press
 * titles rarely match the dev-jargon-heavy taxonomy aliases (see
 * taxonomy.yaml's "press phrasing" note), so this mostly just stops
 * excluding the news mentions that do match.
 */
export async function computeTrendSnapshots(days = 30): Promise<TrendSummary[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const mentions = await prisma.postTrendMention.findMany({
    where: { post: { postedAt: { gte: since } } },
    include: { post: { select: { postedAt: true } }, trend: { select: { name: true, tag: true } } },
  });

  // trendName -> day -> count
  const byTrendDay = new Map<string, Map<string, number>>();
  const tagByTrend = new Map<string, string>();

  for (const m of mentions) {
    const day = m.post.postedAt.toISOString().slice(0, 10);
    tagByTrend.set(m.trend.name, m.trend.tag);
    const dayMap = byTrendDay.get(m.trend.name) ?? new Map<string, number>();
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    byTrendDay.set(m.trend.name, dayMap);
  }

  const summaries: TrendSummary[] = [];
  for (const [trendName, dayMap] of byTrendDay) {
    const history = [...dayMap.entries()]
      .map(([day, count]) => ({ trendName, tag: tagByTrend.get(trendName)!, day, mentions: count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const last7 = history.slice(-7).reduce((sum, r) => sum + r.mentions, 0);
    const prior7 = history.slice(-14, -7).reduce((sum, r) => sum + r.mentions, 0);
    const pctChangeWeek = prior7 === 0 ? (last7 > 0 ? 100 : 0) : ((last7 - prior7) / prior7) * 100;

    summaries.push({
      trendName,
      tag: tagByTrend.get(trendName)!,
      mentions: history.at(-1)?.mentions ?? 0,
      pctChangeWeek,
      history,
    });
  }

  return summaries.sort((a, b) => b.mentions - a.mentions);
}
