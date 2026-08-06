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

## Trends vs digest sourcing

Every `Source` has a `kind`: `community` (HN, Reddit, GitHub, technical blogs)
or `news` (press/journalism RSS — TechCrunch, The Verge, Wired, Ars Technica,
MIT Technology Review). The two feed different parts of the site:

- **Trend radar** (`aggregate`) only counts mentions from `community` sources
  — it measures what developers are actually discussing.
- **Digest** (`group` → `synthesize`) only draws from `news` sources — it
  reads like "here's what's being reported," separate from the radar.

Both still go through the same taxonomy tagging step (`tag`) — the split is
in which tagged posts each downstream stage is allowed to use, not in tagging
itself. Add/move a source's kind in `src/config/sources.yaml`.

> **Known gap, found by testing this live:** the current taxonomy's aliases
> are developer jargon ("mcp server", "agent skill", "rag pipeline") — the
> kind of thing GitHub/HN titles use, not how press outlets write. A live
> run tagged 13 posts, all from GitHub/HN, zero from the 5 news feeds. The
> digest will come up empty until `taxonomy.yaml` also has softer,
> press-style aliases (product/company names like "ChatGPT", "Anthropic",
> "Claude", "Gemini", "AI agent") — not implemented yet, flagging it here
> rather than silently shipping an empty digest.

## Pipeline stages

Daily (`npm run dev all`):

```
ingest → tag → aggregate → group → synthesize → (review) → export
```

| Stage | What it does | Touches an LLM? |
|---|---|---|
| **ingest** | Pull raw posts from HN (Algolia API), GitHub (Search API), Reddit (OAuth API), and RSS blogs | No |
| **tag** | Match post titles against `src/config/taxonomy.yaml` (name + aliases per trend) | No |
| **aggregate** | Count mentions per trend per day, compute week-over-week change | No |
| **group** | Cluster today's top posts by shared trend tag + recency + score | No |
| **synthesize** | Write headline / summary / why-it-matters for each group | **Yes** — one Claude Sonnet 5 call/day, structured output |
| **export** | Write the computed trend snapshots + approved story drafts out, ready to sync into the main app | No |

Weekly, separate from `all` on purpose — this is not a daily cost, and its
output needs a human decision before it affects anything:

```
discover → review (human) → manual taxonomy.yaml PR
```

| Stage | What it does | Touches an LLM? |
|---|---|---|
| **discover** | Embeds titles of posts that matched *no* taxonomy trend in the last 7 days (Voyage AI), clusters them by cosine similarity (plain code, no model), then asks Haiku 4.5 to name/tag clusters of 3+ posts and judge whether each is a real trend or noise | **Yes** — one embedding batch + one Haiku 4.5 call per candidate cluster |
| **review** | Prints pending `ClusterCandidate` rows for a human to eyeball | No |
| *(manual)* | Approve via `tsx scripts/approve.ts <id>`, then hand-add the trend to `taxonomy.yaml` with real aliases and open a PR | No — approving a candidate never auto-edits the taxonomy |

Discovery only ever *proposes*. Nothing it finds affects the radar until a
human adds it to `taxonomy.yaml` — same trust boundary as the rest of the
site's transparency story.

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
| `synthesize`, `discover` (labeling) | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `discover` (embeddings) | `VOYAGE_API_KEY` | [dash.voyageai.com](https://dash.voyageai.com/) — also verify the default embedding model in `src/discover/embed.ts` against current Voyage docs |
| Higher GitHub rate limit | `GITHUB_TOKEN` (optional — works unauthenticated at 60 req/hr) | A classic PAT with no scopes |

Without Reddit credentials, `ingest` still runs — it logs each Reddit
subreddit as skipped rather than failing the whole run.

```bash
npm run dev synthesize   # needs ANTHROPIC_API_KEY
npm run dev export       # writes data/export/{trends,stories}-<date>.json
npm run dev all          # runs the daily stages in order

npm run dev discover     # weekly — needs VOYAGE_API_KEY + ANTHROPIC_API_KEY
npm run dev review       # lists pending cluster candidates
tsx scripts/approve.ts <id>          # approve
tsx scripts/approve.ts <id> reject   # reject
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
