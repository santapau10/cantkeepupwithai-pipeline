import { prisma } from "./lib/prisma.js";
import { buildConnectors } from "./sources/registry.js";
import { ingestConnector, type IngestResult } from "./sources/store.js";
import type { FetchOptions } from "./sources/types.js";
import { tagUntaggedPosts } from "./taxonomy/match.js";
import { computeTrendSnapshots } from "./aggregate/snapshot.js";
import { exportForMainApp } from "./sync/export.js";
import { discoverNewTrends, listPendingCandidates } from "./discover/discover.js";

const DEFAULT_BACKFILL_DAYS = 30;

// No credentials required, so these three should return *something* on
// basically any normal day — unlike Reddit/X (gated by credentials that may
// legitimately be unset) or RSS/Medium (small volume, can genuinely be 0
// some days). All three failing at once is a much stronger signal of an
// actual break (an API changed shape, a network issue) than normal
// day-to-day variance, and each one fails independently (different APIs),
// so a coincidence across all three in one run is unlikely.
const RELIABLE_CONNECTORS = ["Hacker News", "GitHub", "YouTube"];

/**
 * Catches silent data loss, not crashes — a connector that throws already
 * gets caught per-connector (see `ingest` below) and shows up as
 * `error` in its IngestResult, not a thrown exception. This is for the
 * scarier case: a connector "succeeds" (no exception) but its response
 * shape quietly changed and it's actually returning nothing useful. Throws
 * so it propagates through logRun -> main()'s catch -> process.exit(1),
 * which fails the GitHub Actions run — GitHub emails the repo owner on a
 * failed run by default, so that's the whole alerting mechanism, no new
 * infra needed.
 */
function assertIngestHealthy(results: IngestResult[]) {
  const reliable = results.filter((r) => RELIABLE_CONNECTORS.includes(r.sourceName));
  const allEmpty = reliable.length === RELIABLE_CONNECTORS.length && reliable.every((r) => !r.error && r.fetched === 0);
  if (allEmpty) {
    throw new Error(
      `Ingest health check failed: ${RELIABLE_CONNECTORS.join(", ")} all returned 0 posts with no error — ` +
        `likely an API or network issue, not normal daily variance.`,
    );
  }
}

async function logRun(stage: string, fn: () => Promise<Record<string, unknown>>) {
  const start = Date.now();
  try {
    const detail = await fn();
    await prisma.pipelineRun.create({
      data: { stage, postsProcessed: Number(detail.fetched ?? detail.postsScanned ?? 0), detail: JSON.stringify(detail) },
    });
    console.log(`[${stage}] done in ${Date.now() - start}ms`, detail);
  } catch (err) {
    await prisma.pipelineRun.create({ data: { stage, errors: 1, detail: JSON.stringify({ error: (err as Error).message }) } });
    console.error(`[${stage}] failed:`, (err as Error).message);
    throw err;
  }
}

async function ingest(options?: FetchOptions) {
  const connectors = buildConnectors({ backfill: Boolean(options?.days) });
  const results: IngestResult[] = [];
  for (const connector of connectors) {
    const result = await ingestConnector(connector, options);
    results.push(result);
    const dupeNote = result.duplicatesSkipped ? `, ${result.duplicatesSkipped} cross-source dupes skipped` : "";
    const status = result.error ? `SKIPPED (${result.error})` : `${result.stored} new / ${result.fetched} fetched${dupeNote}`;
    console.log(`  ${connector.name}: ${status}`);
  }
  assertIngestHealthy(results);
  return { results };
}

async function tag() {
  return tagUntaggedPosts();
}

async function aggregate() {
  const snapshots = await computeTrendSnapshots();
  console.table(snapshots.map((s) => ({ trend: s.trendName, mentions: s.mentions, "Δ week": `${s.pctChangeWeek.toFixed(0)}%` })));
  return { trendCount: snapshots.length };
}

async function exportStage() {
  return exportForMainApp();
}

async function discover() {
  return discoverNewTrends();
}

async function review() {
  const candidates = await listPendingCandidates();
  if (candidates.length === 0) {
    console.log("No pending cluster candidates.");
    return { pending: 0 };
  }
  for (const c of candidates) {
    console.log(`\n— ${c.suggestedName} [${c.suggestedTag}] (${c.clusterSize} posts)`);
    console.log(`  ${c.rationale}`);
    console.log(`  approve: tsx scripts/approve.ts ${c.id}   reject: tsx scripts/approve.ts ${c.id} reject`);
  }
  return { pending: candidates.length };
}

const STAGES = ["ingest", "tag", "aggregate", "export"] as const;
// discover/review are weekly and manual-review steps — deliberately not part of "all",
// which is meant to run daily. backfill is a one-off, manually-triggered
// historical catch-up — see README § Backfill — never part of the daily/
// weekly schedules either.
const ALL_COMMANDS = [...STAGES, "discover", "review", "backfill", "all"];

/**
 * One-off historical catch-up: ingest (wide window) → tag → aggregate →
 * export, same four stages as `all` but pointed at the past instead of just
 * "since last run". `days` defaults to a month; X ignores anything past its
 * own MAX_BACKFILL_DAYS=14 regardless, to cap pay-per-use cost — see
 * README § Backfill for the full breakdown before running this.
 */
async function backfill(days: number) {
  const options: FetchOptions = { days };
  console.log(`[backfill] ingest window = ${days} days (X capped at 14 regardless — see x.ts)`);
  await logRun("ingest", () => ingest(options));
  await logRun("tag", tag);
  await logRun("aggregate", aggregate);
  await logRun("export", exportStage);
}

async function main() {
  const command = process.argv[2] ?? "all";

  if (command === "backfill") {
    const days = Number(process.argv[3]) || DEFAULT_BACKFILL_DAYS;
    await backfill(days);
  }
  if (command === "ingest" || command === "all") await logRun("ingest", () => ingest());
  if (command === "tag" || command === "all") await logRun("tag", tag);
  if (command === "aggregate" || command === "all") await logRun("aggregate", aggregate);
  if (command === "export" || command === "all") await logRun("export", exportStage);
  if (command === "discover") await logRun("discover", discover);
  if (command === "review") await review();

  if (!ALL_COMMANDS.includes(command as (typeof ALL_COMMANDS)[number])) {
    console.error(`Unknown command "${command}". Use: ${ALL_COMMANDS.join(" | ")}`);
    process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
