# cantkeepupwithai-pipeline

The ingestion, tagging, and digest-synthesis pipeline for [cantkeepupwithai.com](https://github.com/santapau10/cantkeepupwithai).
Reads Hacker News, Reddit, GitHub and engineering blogs, tags mentions against a
version-controlled taxonomy, and drafts the daily digest — designed so **most of
the pipeline is plain deterministic code**, not model calls.

## Why a separate repo

Kept private and separate from the main `cantkeepupwithai` repo on purpose: this
is a scheduled batch/worker system with its own credentials (Reddit, GitHub,
Anthropic API keys), different deploy lifecycle than the web app, and — if it
ever goes public — a natural home for source/taxonomy contributions via PR,
the same model already used for the toolbox on the main site.

## Pipeline stages

```
ingest → tag → aggregate → group → synthesize → (review) → export
```

| Stage | What it does | Touches an LLM? |
|---|---|---|
| **ingest** | Pull raw posts from HN (Algolia API), GitHub (Search API), Reddit (OAuth API), and RSS blogs | No |
| **tag** | Match post titles against `src/config/taxonomy.yaml` (name + aliases per trend) | No |
| **aggregate** | Count mentions per trend per day, compute week-over-week change | No |
| **group** | Cluster today's top posts by shared trend tag + recency + score | No |
| **synthesize** | Write headline / summary / why-it-matters for each group | **Yes — the only model call in the pipeline** (Claude Sonnet 5, structured output) |
| **export** | Write the computed trend snapshots + approved story drafts out, ready to sync into the main app | No |

A weekly embedding-based cluster-discovery pass (to catch trends the taxonomy
doesn't know about yet) is designed but not implemented in this first pass —
see the plan discussion this repo came out of. `ClusterCandidate` is already
in the schema for when that lands.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env
npx prisma db push   # creates prisma/dev.db (SQLite, same pattern as the main app)
```

## What runs right now, with zero credentials

```bash
npm run dev ingest     # HN + GitHub + any enabled RSS feeds — no auth needed
npm run dev tag        # deterministic taxonomy matching
npm run dev aggregate  # mention counts + Δ week, printed as a table
```

## What needs credentials before it runs

| Stage | Needs | Get it from |
|---|---|---|
| Reddit ingest | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | Create a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) |
| `synthesize` | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| Higher GitHub rate limit | `GITHUB_TOKEN` (optional — works unauthenticated at 60 req/hr) | A classic PAT with no scopes |

Without Reddit credentials, `ingest` still runs — it logs each Reddit
subreddit as skipped rather than failing the whole run.

```bash
npm run dev synthesize   # needs ANTHROPIC_API_KEY
npm run dev export       # writes data/export/{trends,stories}-<date>.json
npm run dev all          # runs every stage in order
```

## Syncing into the main app

The main `cantkeepupwithai` repo doesn't have a write endpoint for
trends/digests yet — that's the next cross-repo piece. Until then, `export`
writes the exact shapes it would send as JSON files under `data/export/`, so
wiring it up later is a matter of pointing that stage at an admin API call
instead of a file write, not a redesign.

## Sources

`src/config/sources.yaml` lists the 11 subreddits and the (currently short —
not the ~62 implied by the main site's copy) RSS feed list. `src/config/taxonomy.yaml`
lists the trends and their match aliases. Both are meant to be edited via PR —
that's the point of keeping them as files instead of admin-panel state.

## Cost

At current volumes this runs for roughly **$15–30/month all-in**: source APIs
are free, hosting fits in GitHub Actions' free tier for a scheduled workflow,
and the only line item that scales with usage is the daily `synthesize` call
(~$0.60–0.90/day on Claude Sonnet 5). See the plan discussion for the full
breakdown.
