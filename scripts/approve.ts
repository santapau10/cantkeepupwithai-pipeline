// Usage: tsx scripts/approve.ts <candidateId> [reject]
// Approving here only marks the DB row — it does NOT touch taxonomy.yaml.
// Adding the trend for real is still a manual PR: take suggestedName/
// suggestedTag from this candidate, pick real aliases from the sample
// posts, and add an entry to src/config/taxonomy.yaml yourself.
import { prisma } from "../src/lib/prisma.js";

const [id, action] = process.argv.slice(2);
if (!id) {
  console.error("Usage: tsx scripts/approve.ts <candidateId> [reject]");
  process.exit(1);
}

const status = action === "reject" ? "rejected" : "approved";
const candidate = await prisma.clusterCandidate.update({ where: { id }, data: { status } });

console.log(`${candidate.suggestedName} → ${status}`);
if (status === "approved") {
  console.log("Next: add it to src/config/taxonomy.yaml by hand (name, tag, real aliases) and open a PR.");
}

await prisma.$disconnect();
