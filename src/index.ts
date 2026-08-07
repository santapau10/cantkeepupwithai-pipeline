import { prisma } from "./lib/prisma.js";
import { buildConnectors } from "./sources/registry.js";
import { ingestConnector } from "./sources/store.js";
import { tagUntaggedPosts } from "./taxonomy/match.js";
import { computeTrendSnapshots } from "./aggregate/snapshot.js";
import { exportForMainApp } from "./sync/export.js";
import { discoverNewTrends, listPendingCandidates } from "./discover/discover.js";

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

async function ingest() {
  const connectors = buildConnectors();
  const results = [];
  for (const connector of connectors) {
    const result = await ingestConnector(connector);
    results.push(result);
    const dupeNote = result.duplicatesSkipped ? `, ${result.duplicatesSkipped} cross-source dupes skipped` : "";
    const status = result.error ? `SKIPPED (${result.error})` : `${result.stored} new / ${result.fetched} fetched${dupeNote}`;
    console.log(`  ${connector.name}: ${status}`);
  }
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
// which is meant to run daily.
const ALL_COMMANDS = [...STAGES, "discover", "review", "all"];

async function main() {
  const command = process.argv[2] ?? "all";

  if (command === "ingest" || command === "all") await logRun("ingest", ingest);
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
