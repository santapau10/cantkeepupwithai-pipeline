// Isolated tests (Node's built-in test runner via `tsx --test` — no new
// dependency) for the failure-handling fixes in fetchTrendingRepos /
// exportTrendingForMainApp: a GitHub API outage/rate-limit that fails every
// topic search must abort the sync rather than replace the live Trending
// batch with an empty one. Mocks `fetch` — never hits the real GitHub API
// or the webapp's sync endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";

function githubItems(items: { id: number; full_name: string; description: string | null; stargazers_count: number; language: string | null }[]) {
  return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
}

test("fetchTrendingRepos throws when every topic search fails (rate limit / auth / network)", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  try {
    const { fetchTrendingRepos } = await import("./trending.js");
    await assert.rejects(() => fetchTrendingRepos(), /all 5 trending topic searches failed/i);
    // One call per topic in TOPIC_FIELD_MAP.
    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTrendingRepos still returns results when only some topics fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // "%20" right after "llm" distinguishes the `llm` topic query from
    // `llmops`'s (which would otherwise also match a plain "topic%3Allm" substring check).
    if (url.includes("topic%3Allm%20")) {
      return githubItems([
        { id: 1, full_name: "owner/repo-no-description", description: null, stargazers_count: 100, language: "Python" },
      ]);
    }
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  try {
    const { fetchTrendingRepos } = await import("./trending.js");
    const repos = await fetchTrendingRepos();
    assert.equal(repos.length, 1);
    // Repos with no GitHub description get a non-empty fallback, not "" —
    // an empty string would be dropped by the backend's create-tool
    // validation (see backend/src/routes/pipeline.ts's `t?.description` check).
    assert.equal(repos[0].description, "owner/repo-no-description on GitHub");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exportTrendingForMainApp aborts the sync (never POSTs to the webapp) when GitHub search fails entirely", async () => {
  const originalFetch = globalThis.fetch;
  const originalSyncUrl = process.env.WEB_SYNC_URL;
  const originalSyncKey = process.env.WEB_SYNC_API_KEY;
  process.env.WEB_SYNC_URL = "http://sync.invalid";
  process.env.WEB_SYNC_API_KEY = "test-key";

  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calledUrls.push(String(input));
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  try {
    const { exportTrendingForMainApp } = await import("../sync/export.js");
    await assert.rejects(() => exportTrendingForMainApp());
    // Only the (failing) GitHub search calls happened — the sync POST to
    // the webapp (and therefore its deleteMany/createMany replace) was
    // never reached.
    assert.ok(calledUrls.length > 0, "expected the GitHub search calls to have happened");
    assert.ok(
      calledUrls.every((u) => u.includes("api.github.com")),
      `expected only api.github.com calls, got: ${calledUrls.join(", ")}`,
    );
    assert.ok(!calledUrls.some((u) => u.includes("sync.invalid")), "must not have POSTed to the sync endpoint");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSyncUrl === undefined) delete process.env.WEB_SYNC_URL;
    else process.env.WEB_SYNC_URL = originalSyncUrl;
    if (originalSyncKey === undefined) delete process.env.WEB_SYNC_API_KEY;
    else process.env.WEB_SYNC_API_KEY = originalSyncKey;
  }
});
