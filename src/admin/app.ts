import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { requireAdminAuth } from "./auth.js";

const app = express();
app.set("trust proxy", 1);

// Single known origin (the main site's frontend), not a wildcard — this API
// can mutate taxonomy review state, unlike the public read-only /api/pipeline
// endpoint on the main backend.
const allowedOrigin = process.env.ADMIN_CORS_ORIGIN;
app.use(cors({ origin: allowedOrigin ? [allowedOrigin] : false, credentials: false }));
app.use(express.json());

// Login surface — worth a tighter limiter than a typical read endpoint,
// same reasoning as the main backend's apiRateLimiter (in-memory, per
// serverless instance — a first line of defense, not the only one).
app.use(
  "/admin",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down and try again in a minute." },
  }),
);

app.get("/admin/health", (_req, res) => res.json({ ok: true }));

app.use("/admin", requireAdminAuth);

/**
 * Pending cluster candidates from `discover`, hydrated with real sample
 * post titles (samplePostIds -> RawPost) so the admin UI doesn't need a
 * second round trip. Read-only — never touches taxonomy.yaml, same trust
 * boundary as scripts/approve.ts.
 */
app.get("/admin/candidates", async (_req, res) => {
  const candidates = await prisma.clusterCandidate.findMany({
    where: { status: "pending" },
    orderBy: { clusterSize: "desc" },
  });

  const result = await Promise.all(
    candidates.map(async (c) => {
      const postIds: string[] = JSON.parse(c.samplePostIds);
      const posts = postIds.length
        ? await prisma.rawPost.findMany({ where: { id: { in: postIds } }, select: { title: true, url: true } })
        : [];
      return {
        id: c.id,
        suggestedName: c.suggestedName,
        suggestedTag: c.suggestedTag,
        rationale: c.rationale,
        clusterSize: c.clusterSize,
        createdAt: c.createdAt,
        samplePosts: posts,
      };
    }),
  );

  res.json({ candidates: result });
});

/**
 * Approving/rejecting here only flips `status` in the database, exactly
 * like `tsx scripts/approve.ts <id>` does today — it never writes to
 * taxonomy.yaml. Adding an approved trend for real is still a manual PR:
 * the frontend is expected to show that follow-up step, not imply this
 * button does it.
 */
async function setStatus(id: string, status: "approved" | "rejected", res: express.Response) {
  try {
    const candidate = await prisma.clusterCandidate.update({ where: { id }, data: { status } });
    res.json({ candidate });
  } catch {
    res.status(404).json({ error: `No candidate with id ${id}` });
  }
}

app.post("/admin/candidates/:id/approve", (req, res) => setStatus(req.params.id, "approved", res));
app.post("/admin/candidates/:id/reject", (req, res) => setStatus(req.params.id, "rejected", res));

// Vercel's Node-backend detection looks for a default export of the app
// instance (mirrors cantkeepupwithai/backend/src/app.ts) — see
// src/admin/serve.ts for the local dev entrypoint instead, and vercel.json
// for the explicit build config pointing at this file.
export default app;
