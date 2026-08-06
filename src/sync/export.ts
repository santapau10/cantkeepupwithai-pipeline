import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { computeTrendSnapshots } from "../aggregate/snapshot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, "../../data/export");

/**
 * The main app (cantkeepupwithai repo) doesn't yet have a write endpoint
 * for trends/digests — that's the next cross-repo piece. Until then, this
 * writes the shapes it would send, as JSON, so the sync step is easy to
 * wire up later without redesigning it: point this at an admin API call
 * instead of a file write.
 */
export async function exportForMainApp() {
  mkdirSync(exportDir, { recursive: true });

  const trends = await computeTrendSnapshots();
  const stories = await prisma.storyDraft.findMany({ where: { status: "approved" } });

  const today = new Date().toISOString().slice(0, 10);
  const trendsPath = path.join(exportDir, `trends-${today}.json`);
  const storiesPath = path.join(exportDir, `stories-${today}.json`);

  writeFileSync(trendsPath, JSON.stringify(trends, null, 2));
  writeFileSync(storiesPath, JSON.stringify(stories, null, 2));

  return { trendsPath, storiesPath, trendCount: trends.length, storyCount: stories.length };
}
