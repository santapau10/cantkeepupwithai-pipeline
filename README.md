# cantkeepupwithai-pipeline

The ingestion and tagging pipeline for [cantkeepupwithai.com](https://github.com/santapau10/cantkeepupwithai).
Reads Hacker News, Reddit, GitHub, X and engineering/press RSS, tags mentions
against a version-controlled taxonomy, and feeds the trend radar — designed
so **most of the pipeline is plain deterministic code**, not model calls.

## Why a separate repo

Kept private and separate from the main `cantkeepupwithai` repo on purpose: this
is a scheduled batch/worker system with its own credentials (Reddit, GitHub,
Anthropic API keys), different deploy lifecycle than the web app, and — if it
ever goes public — a natural home for source/taxonomy contributions via PR,
the same model already used for the toolbox on the main site.

## No more Digest — everything feeds the trend radar

This pipeline used to also draft a daily "Digest" — LLM-written stories
summarizing the day's press coverage, separate from the trend radar. That's
gone. Every `Source` still has a `kind` (`community`: HN, Reddit, GitHub, X,
technical blogs — or `news`: press/journalism RSS like TechCrunch, The
Verge, Wired, Ars Technica, MIT Technology Review), but the field is now
metadata only — `aggregate` counts mentions from **all** sources into the
trend radar, `kind` isn't filtered on anymore.

In practice this mostly just stops *excluding* news mentions that already
matched something — general tech press still mostly doesn't cover the same
narrow dev-tool trends in the same dev-jargon words community sources do
(measured empirically: broadening the taxonomy's aliases moved
community-source matches 13 → 23 but news-source matches stayed at 0 under
plain keyword matching). That gap is what the embedding fallback pass in
`tag` (below) exists to narrow.

## Two-pass tagging: keyword match, then embedding fallback

`tag` runs in two passes now:

1. **Keyword match** (unchanged) — case-insensitive substring match of each
   trend's aliases against the post title. Deterministic, no model call.
2. **Embedding fallback** (`src/taxonomy/semanticMatch.ts`) — for whatever's
   still untagged after pass 1, embeds the post title and each trend's
   `name + aliases` (Voyage AI), and tags the post against its
   best-matching trend if the cosine similarity clears a conservative
   threshold (0.84 — tighter than the 0.82 `discover` uses for clustering,
   since a false match here silently inflates a public mention count rather
   than producing an editorial draft someone reviews). These mentions are
   marked `~semantic:<score>` in `matchedKeyword` instead of a literal
   alias, so they stay auditable and separable from exact keyword matches.

This is why `tag` now needs `VOYAGE_API_KEY` too — flagged in the
credentials table below. If it's not set, pass 2 is skipped (logged, not a
failure) and `tag` still runs keyword-only, same as before this change.

## Pipeline stages

Daily (`npm run dev all`):

```
ingest → tag → aggregate → export
```

| Stage | What it does | Touches an LLM? |
|---|---|---|
| **ingest** | Pull raw posts from HN (Algolia API), GitHub (Search API), Reddit (OAuth API), X (v2 API), and RSS blogs | No |
| **tag** | Match post titles against `src/config/taxonomy.yaml` (name + aliases per trend), then an embedding fallback pass for what's still untagged | Embeddings only (fallback pass), no LLM call |
| **aggregate** | Count mentions per trend per day (all sources), compute week-over-week change | No |
| **export** | Write the computed trend snapshots out, ready to sync into the main app | No |

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
npm run dev tag        # keyword matching (embedding fallback skips itself without VOYAGE_API_KEY)
npm run dev aggregate  # mention counts + Δ week, printed as a table
```

## What needs credentials before it runs

| Stage | Needs | Get it from |
|---|---|---|
| Reddit ingest | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | Create a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) |
| X ingest | `X_BEARER_TOKEN` | A Pay-Per-Use app at [developer.x.com](https://developer.x.com) |
| `tag`'s embedding fallback, `discover` (embeddings) | `VOYAGE_API_KEY` | [dash.voyageai.com](https://dash.voyageai.com/) — `voyage-4-lite`, $0.02/1M tokens after the first 200M free/account (checked against docs.voyageai.com/docs/pricing) |
| `discover` (labeling) | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) — no longer needed on the daily path, only weekly `discover` |
| Higher GitHub rate limit | `GITHUB_TOKEN` (optional — works unauthenticated at 60 req/hr) | A classic PAT with no scopes |

Without Reddit credentials, `ingest` still runs — it logs each Reddit
subreddit as skipped rather than failing the whole run. Same for `tag`
without `VOYAGE_API_KEY`: the keyword pass still runs, the embedding
fallback pass just skips itself.

```bash
npm run dev export       # writes data/export/{trends,sync}-<date>.json
npm run dev all          # runs the daily stages in order

npm run dev discover     # weekly — needs VOYAGE_API_KEY + ANTHROPIC_API_KEY
npm run dev review       # lists pending cluster candidates
tsx scripts/approve.ts <id>          # approve
tsx scripts/approve.ts <id> reject   # reject
```

## Syncing into the main app

`export` POSTs its trend payload to the main `cantkeepupwithai` repo's
`POST /api/pipeline/sync`, authenticated with a shared secret
(`WEB_SYNC_API_KEY` here must match `PIPELINE_API_KEY` in that repo's
`backend/.env`). It also still writes the same payload to
`data/export/sync-<date>.json` regardless of whether the sync succeeds —
useful for debugging a run without the web app up. Set `WEB_SYNC_URL` /
`WEB_SYNC_API_KEY` in `.env` (see `.env.example`); leave either blank to skip
syncing and only write the local file.

**Note:** the payload no longer has a `digest` field (Digest was removed
from this pipeline — see "No more Digest" above). The main `cantkeepupwithai`
repo's `/api/pipeline/sync` handler and its Digest UI section need a
corresponding change on that side; that's out of scope for this repo but
has to happen for the two to stay in sync.

Two GitHub Actions workflows exist for this (`.github/workflows/`): `daily.yml`
runs `ingest → tag → aggregate → export` every day, `discover.yml`
runs the weekly-ish new-trend discovery pass every ~3 days. The main app is
now deployed (`https://cantkeepupwithai-backend.vercel.app`), so `WEB_SYNC_URL`
is no longer blocked on that.

**Both schedules are deliberately commented out in the workflow files** —
each run spends real Voyage (and, weekly, Anthropic) API usage, so nothing
runs automatically until that's a conscious choice. Uncomment the
`schedule:` block in either file to arm it, once repo secrets are set
(`DATABASE_URL` for this pipeline's own Neon project, `VOYAGE_API_KEY`,
`ANTHROPIC_API_KEY` for `discover.yml`, `WEB_SYNC_URL`/`WEB_SYNC_API_KEY`,
plus whichever source connector credentials are enabled).
`workflow_dispatch` (manual trigger, from the GitHub Actions UI or
`gh workflow run`) works today for either one and is the recommended way to
test a run before arming the schedule.

## Sources

`src/config/sources.yaml` lists the 11 subreddits, the rotating list of
tracked X accounts, and the (currently short — not the ~62 implied by the
main site's copy) RSS feed list. `src/config/taxonomy.yaml` lists the trends
and their match aliases. Both are meant to be edited via PR — that's the
point of keeping them as files instead of admin-panel state.

## Cost

Source APIs are free except X (pay-per-use, ~$7.50/mo at the current
rotation — see `sources.yaml`), and hosting fits in GitHub Actions' free
tier for a scheduled workflow. The only other line item that scales with
usage is daily embeddings for `tag`'s fallback pass (a few hundred post
titles/day — trivial, well under $0.01/day on Voyage's per-token pricing).
There's no daily Anthropic cost anymore — `synthesize`/Digest is gone, so
`ANTHROPIC_API_KEY` is only spent on the weekly `discover` pass.
