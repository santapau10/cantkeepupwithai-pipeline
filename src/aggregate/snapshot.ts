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
  // Distinct sources (not posts) that mentioned this trend in each window —
  // the "is this genuinely spreading, or just one loud subreddit" signal.
  // See sources/store.ts's storyGroupId for how cross-source coverage of
  // the same story gets recognized in the first place.
  sourceBreadth7d: number;
  sourceBreadth30d: number;
  // How unusual the last MOMENTUM_RECENT_DAYS days are against this trend's
  // own baseline — see computeMomentum() below for the formula. Positive
  // means "more than usual", not "more than last week" (that's
  // pctChangeWeek) — the two answer different questions and can disagree.
  momentumZScore: number;
  // Deterministic rule over momentumZScore + source-breadth velocity — see
  // computeMomentum(). Not a separate model call or a frontend threshold
  // check: computed once here, synced as a plain boolean, same "pipeline
  // computes it, web just displays it" split as everything else.
  isBreaking: boolean;
};

const SOURCE_BREADTH_SHORT_WINDOW_DAYS = 7;

// --- Momentum: is *today* unusual for this trend, not just "up from last
// week"? pctChangeWeek (last7 vs prior7, both summed) is a fine sustained-
// trend signal but is blind to two things this project's whole point is to
// catch: (a) a trend with a small, noisy base can swing +700% off 1-2
// mentions — statistically meaningless, not real momentum (seen in
// production on "Context window management") — and (b) it can't tell a
// trend that's spreading to new, independent sources from one that's just
// getting louder in the same single subreddit it always lived in.
//
// MOMENTUM_BASELINE_DAYS + MOMENTUM_RECENT_DAYS = 24, comfortably inside
// the 30-day window computeTrendSnapshots already fetches — no extra query.
const MOMENTUM_BASELINE_DAYS = 21;
const MOMENTUM_RECENT_DAYS = 3;
// Roughly "the last 3 days ran at ~2 standard deviations above this
// trend's own last-21-day norm" — a real outlier, not routine day-to-day
// noise (which for a Poisson-ish daily count is usually within ~1 stddev).
const MOMENTUM_Z_THRESHOLD = 2;
// Floor so a trend that went from 0 to 1 daily mention can't cross the
// z-score threshold on volume alone — a jump from a near-zero baseline can
// produce a huge z-score off one or two stray posts.
const MOMENTUM_MIN_RECENT_STORIES = 3;
// Floor on the baseline's own stddev so a flat, quiet trend (baseline
// stddev near 0) doesn't turn one extra post into a runaway z-score from
// dividing by almost nothing.
const MOMENTUM_MIN_STDDEV = 0.5;

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Oldest → newest, `totalDays` consecutive calendar days ending today (inclusive). */
function trailingDayWindow(totalDays: number): string[] {
  const days: string[] = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    days.push(dayString(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }
  return days;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stddev(xs: number[], m: number): number {
  if (xs.length === 0) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * z-score of the last MOMENTUM_RECENT_DAYS days' average story count
 * against this trend's own MOMENTUM_BASELINE_DAYS-day baseline, plus
 * whether distinct-source coverage grew over the same split — both zero-
 * filled against calendar days (not just days that had activity), so a
 * trend that's usually quiet gets a real, low baseline instead of an
 * artificially high one from skipping its silent days.
 */
function computeMomentum(
  dailyStoryCounts: Map<string, number>,
  dailySources: Map<string, Set<string>>,
): { momentumZScore: number; isBreaking: boolean } {
  const allDays = trailingDayWindow(MOMENTUM_BASELINE_DAYS + MOMENTUM_RECENT_DAYS);
  const baselineDays = allDays.slice(0, MOMENTUM_BASELINE_DAYS);
  const recentDays = allDays.slice(MOMENTUM_BASELINE_DAYS);
  // The BASELINE_DAYS days immediately before the recent window — same
  // length as `recentDays`, so the source-breadth comparison is
  // apples-to-apples (N days of coverage vs. the previous N days), not
  // "3 days vs. 21 days".
  const priorBreadthDays = baselineDays.slice(-MOMENTUM_RECENT_DAYS);

  const baselineCounts = baselineDays.map((d) => dailyStoryCounts.get(d) ?? 0);
  const recentCounts = recentDays.map((d) => dailyStoryCounts.get(d) ?? 0);

  const baselineMean = mean(baselineCounts);
  const baselineStd = Math.max(stddev(baselineCounts, baselineMean), MOMENTUM_MIN_STDDEV);
  const recentAvg = mean(recentCounts);
  const momentumZScore = Number(((recentAvg - baselineMean) / baselineStd).toFixed(2));
  const recentStorySum = recentCounts.reduce((a, b) => a + b, 0);

  const union = (days: string[]) => {
    const s = new Set<string>();
    for (const d of days) for (const src of dailySources.get(d) ?? []) s.add(src);
    return s;
  };
  const breadthDelta = union(recentDays).size - union(priorBreadthDays).size;

  const isBreaking =
    momentumZScore >= MOMENTUM_Z_THRESHOLD && recentStorySum >= MOMENTUM_MIN_RECENT_STORIES && breadthDelta > 0;

  return { momentumZScore, isBreaking };
}

/**
 * Pure aggregation — SQL/JS grouping over already-tagged mentions.
 * No model call: this is what feeds TrendSnapshot on the main app.
 *
 * All sources count equally now (community and news alike) — there is no
 * separate digest to keep news mentions out of anymore. In practice, press
 * titles rarely match the dev-jargon-heavy taxonomy aliases (see
 * taxonomy.yaml's "press phrasing" note), so this mostly just stops
 * excluding the news mentions that do match.
 *
 * Mentions are counted per distinct STORY, not per raw post: a story
 * covered by 3 sources (see sources/store.ts's storyGroupId grouping at
 * ingest time) counts once per trend per day, not three times — otherwise
 * a trend's daily count would mostly reflect how much cross-source
 * coverage happened to exist that day rather than how many distinct things
 * were actually said about it. `storyGroupId ?? postId` is the story key —
 * a post with no recognized duplicate is trivially its own one-post story,
 * so this falls back to the old per-post counting wherever grouping never
 * found a match (e.g. VOYAGE_API_KEY unset, or the post is genuinely
 * unique).
 */
export async function computeTrendSnapshots(days = 30): Promise<TrendSummary[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const shortWindowSince = new Date(Date.now() - SOURCE_BREADTH_SHORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const mentions = await prisma.postTrendMention.findMany({
    where: { post: { postedAt: { gte: since } } },
    include: {
      post: { select: { postedAt: true, storyGroupId: true, sourceId: true } },
      trend: { select: { name: true, tag: true } },
    },
  });

  const tagByTrend = new Map<string, string>();
  const byTrendDay = new Map<string, Map<string, number>>();
  // trendName -> day -> story keys already counted that day, so a second
  // (or third) source's post on the same story doesn't bump the day's count.
  const seenStoryByTrendDay = new Map<string, Map<string, Set<string>>>();
  // trendName -> day -> distinct sourceIds seen that day — feeds both the
  // window-level sourceBreadth7d/30d below and computeMomentum()'s
  // breadth-delta check.
  const sourcesByTrendDay = new Map<string, Map<string, Set<string>>>();
  const sources7dByTrend = new Map<string, Set<string>>();
  const sources30dByTrend = new Map<string, Set<string>>();

  for (const m of mentions) {
    const day = m.post.postedAt.toISOString().slice(0, 10);
    const storyKey = m.post.storyGroupId ?? m.postId;
    tagByTrend.set(m.trend.name, m.trend.tag);

    const seenByDay = seenStoryByTrendDay.get(m.trend.name) ?? new Map<string, Set<string>>();
    const seen = seenByDay.get(day) ?? new Set<string>();
    if (!seen.has(storyKey)) {
      seen.add(storyKey);
      const dayMap = byTrendDay.get(m.trend.name) ?? new Map<string, number>();
      dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
      byTrendDay.set(m.trend.name, dayMap);
    }
    seenByDay.set(day, seen);
    seenStoryByTrendDay.set(m.trend.name, seenByDay);

    const dayMapForSources = sourcesByTrendDay.get(m.trend.name) ?? new Map<string, Set<string>>();
    const sourcesForDay = dayMapForSources.get(day) ?? new Set<string>();
    sourcesForDay.add(m.post.sourceId);
    dayMapForSources.set(day, sourcesForDay);
    sourcesByTrendDay.set(m.trend.name, dayMapForSources);

    const sources30d = sources30dByTrend.get(m.trend.name) ?? new Set<string>();
    sources30d.add(m.post.sourceId);
    sources30dByTrend.set(m.trend.name, sources30d);

    if (m.post.postedAt >= shortWindowSince) {
      const sources7d = sources7dByTrend.get(m.trend.name) ?? new Set<string>();
      sources7d.add(m.post.sourceId);
      sources7dByTrend.set(m.trend.name, sources7d);
    }
  }

  const summaries: TrendSummary[] = [];
  for (const [trendName, dayMap] of byTrendDay) {
    const history = [...dayMap.entries()]
      .map(([day, count]) => ({ trendName, tag: tagByTrend.get(trendName)!, day, mentions: count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const last7 = history.slice(-7).reduce((sum, r) => sum + r.mentions, 0);
    const prior7 = history.slice(-14, -7).reduce((sum, r) => sum + r.mentions, 0);
    const pctChangeWeek = prior7 === 0 ? (last7 > 0 ? 100 : 0) : ((last7 - prior7) / prior7) * 100;

    const { momentumZScore, isBreaking } = computeMomentum(dayMap, sourcesByTrendDay.get(trendName) ?? new Map());

    summaries.push({
      trendName,
      tag: tagByTrend.get(trendName)!,
      mentions: history.at(-1)?.mentions ?? 0,
      pctChangeWeek,
      history,
      sourceBreadth7d: sources7dByTrend.get(trendName)?.size ?? 0,
      sourceBreadth30d: sources30dByTrend.get(trendName)?.size ?? 0,
      momentumZScore,
      isBreaking,
    });
  }

  return summaries.sort((a, b) => b.mentions - a.mentions);
}
