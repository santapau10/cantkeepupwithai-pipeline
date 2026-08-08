// Usage: tsx scripts/applyCandidate.ts <candidateId>
//
// Second half of the "approve" flow — the web admin's approve button flips
// ClusterCandidate.status to "approved" and dispatches the pipeline's
// apply-candidate.yml workflow with this id; that workflow runs this
// script, then commits+pushes the result, then runs tag/aggregate/export.
// Doing this as a plain script (not inline in the workflow YAML) keeps it
// runnable/testable locally the same way scripts/approve.ts is.
//
// Only ever appends to taxonomy.yaml — never edits or removes an existing
// entry, and is a no-op if a trend with this name is already in the file
// (idempotent: safe to re-run if the workflow retries).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { loadTaxonomy } from "../src/taxonomy/match.js";
import { labelCluster } from "../src/discover/label.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const taxonomyPath = path.join(here, "../src/config/taxonomy.yaml");

const [id] = process.argv.slice(2);
if (!id) {
  console.error("Usage: tsx scripts/applyCandidate.ts <candidateId>");
  process.exit(1);
}

const candidate = await prisma.clusterCandidate.findUnique({ where: { id } });
if (!candidate) {
  console.error(`No candidate with id ${id}`);
  process.exit(1);
}
if (candidate.status !== "approved") {
  console.error(`Candidate ${id} is "${candidate.status}", not "approved" — refusing to apply. ` +
    `Approve it first (the /admin button does this before dispatching this script).`);
  process.exit(1);
}

const existing = loadTaxonomy();
if (existing.some((t) => t.name === candidate.suggestedName)) {
  console.log(`"${candidate.suggestedName}" is already in taxonomy.yaml — nothing to do.`);
  process.exit(0);
}

let aliases: string[] = JSON.parse(candidate.suggestedAliases || "[]");
if (aliases.length === 0) {
  // Older candidates (created before suggestedAliases existed) — regenerate
  // from the same sample titles rather than landing with zero match aliases.
  console.log("No stored aliases, asking the labeling model again from the sample titles...");
  const sampleIds: string[] = JSON.parse(candidate.samplePostIds);
  const posts = await prisma.rawPost.findMany({ where: { id: { in: sampleIds } }, select: { title: true } });
  const label = await labelCluster(posts.map((p) => p.title));
  aliases = label.suggestedAliases;
}

const block = [
  "",
  `  # Auto-added from an approved discover candidate (cluster_candidates id ${candidate.id}).`,
  `  # ${candidate.rationale}`,
  `  - name: "${candidate.suggestedName}"`,
  `    tag: ${candidate.suggestedTag}`,
  "    aliases:",
  ...aliases.map((a) => `      - "${a}"`),
].join("\n");

const yaml = readFileSync(taxonomyPath, "utf8");
writeFileSync(taxonomyPath, yaml.replace(/\s*$/, "") + "\n" + block + "\n");

console.log(`Added "${candidate.suggestedName}" (${candidate.suggestedTag}) with ${aliases.length} aliases.`);

await prisma.$disconnect();
