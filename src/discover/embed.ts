// Anthropic doesn't offer a first-party embeddings endpoint. Voyage AI is
// their recommended partner for this — https://docs.voyageai.com/docs/embeddings.
// voyage-4-lite: $0.02/1M tokens after the first 200M tokens/account, which
// are free — checked against docs.voyageai.com/docs/pricing. At this
// pipeline's volume (a few hundred titles/day) that free tier lasts years.
const DEFAULT_MODEL = process.env.VOYAGE_EMBEDDING_MODEL ?? "voyage-4-lite";
const BATCH_SIZE = 100; // conservative — check Voyage's current per-request limit before raising

type VoyageResponse = { data: { embedding: number[]; index: number }[] };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Returns embeddings in the same order as `texts`. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY not set — get one at https://dash.voyageai.com/");
  }

  const results: number[][] = [];
  for (const batch of chunk(texts, BATCH_SIZE)) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: batch, model: DEFAULT_MODEL }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as VoyageResponse;
    const ordered = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    results.push(...ordered);
  }

  return results;
}
