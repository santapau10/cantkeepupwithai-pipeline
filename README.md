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

The trend radar goes through taxonomy tagging (`tag`) — same as before.

The digest does **not** anymore. It used to (group by shared taxonomy tag),
but testing it live found that general tech press mostly doesn't cover the
same narrow dev-tool trends the radar tracks, in the same words or at all —
broadening the taxonomy's aliases moved community-source matches 13 → 23 but
news-source matches stayed at 0. That's not an alias problem, it's a
structural one: the radar and the digest are about genuinely different
things (community micro-trends vs. what's being reported), so tying digest
grouping to the same taxonomy was the wrong coupling.

**Current design:** digest grouping (`group`) embeds today's news post
titles and clusters them by topical similarity (Voyage AI + the same greedy
cosine-similarity clustering `discover` uses) — no taxonomy involved. The
LLM writes the story for whatever cluster the embeddings produced, including
naming what it's actually about. This means `synthesize` now needs
`VOYAGE_API_KEY` too, not just `discover` — a real cost/dependency change
from the previous design, flagged in the credentials table below.

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
| **group** | Embed today's news post titles and cluster by topical similarity (min 2 posts/cluster) | **Yes** — embeddings only, no LLM call |
| **synthesize** | Write headline / summary / why-it-matters for each cluster | **Yes** — one Claude Sonnet 5 call/day, structured output |
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
# edit .env: paste your Neon project's connection string into DATABASE_URL —
# a project of its own, separate from the main cantkeepupwithai app's database
npx prisma db push
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
| `group` (called by `synthesize`), `discover` (embeddings) | `VOYAGE_API_KEY` | [dash.voyageai.com](https://dash.voyageai.com/) — `voyage-4-lite`, $0.02/1M tokens after the first 200M free/account (checked against docs.voyageai.com/docs/pricing) |
| Higher GitHub rate limit | `GITHUB_TOKEN` (optional — works unauthenticated at 60 req/hr) | A classic PAT with no scopes |

`synthesize` needs **both** `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` now —
grouping (embeddings) happens first, writing (Claude) happens second, same
call.

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

`export` POSTs its trend/digest payload to the main `cantkeepupwithai` repo's
`POST /api/pipeline/sync`, authenticated with a shared secret
(`WEB_SYNC_API_KEY` here must match `PIPELINE_API_KEY` in that repo's
`backend/.env`). It also still writes the same payload to
`data/export/sync-<date>.json` regardless of whether the sync succeeds —
useful for debugging a run without the web app up. Set `WEB_SYNC_URL` /
`WEB_SYNC_API_KEY` in `.env` (see `.env.example`); leave either blank to skip
syncing and only write the local file.

Two GitHub Actions workflows exist for this (`.github/workflows/`): `daily.yml`
runs `ingest → tag → aggregate → synthesize → export` every day, `discover.yml`
runs the weekly-ish new-trend discovery pass every ~3 days. The main app is
now deployed (`https://cantkeepupwithai-backend.vercel.app`), so `WEB_SYNC_URL`
is no longer blocked on that.

**Both schedules are deliberately commented out in the workflow files** —
each run spends real Anthropic + Voyage API usage, so nothing runs
automatically until that's a conscious choice. Uncomment the `schedule:`
block in either file to arm it, once repo secrets are set (`DATABASE_URL` for
this pipeline's own Neon project, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
`WEB_SYNC_URL`/`WEB_SYNC_API_KEY`, plus whichever source connector
credentials are enabled). `workflow_dispatch` (manual trigger, from the
GitHub Actions UI or `gh workflow run`) works today for either one and is
the recommended way to test a run before arming the schedule.

## Sources

`src/config/sources.yaml` lists the 11 subreddits and the (currently short —
not the ~62 implied by the main site's copy) RSS feed list. `src/config/taxonomy.yaml`
lists the trends and their match aliases. Both are meant to be edited via PR —
that's the point of keeping them as files instead of admin-panel state.

## Cost

At current volumes this runs for roughly **$15–30/month all-in**: source APIs
are free, hosting fits in GitHub Actions' free tier for a scheduled workflow,
and the two line items that scale with usage are the daily `synthesize` call
(~$0.60–0.90/day on Claude Sonnet 5) and daily embeddings for digest grouping
(a few hundred news post titles/day — trivial, well under $0.01/day on
Voyage's per-token pricing). See the plan discussion for the full breakdown;
note it predates moving embeddings onto the daily path, so the original
cost table undercounts this by a negligible amount.
