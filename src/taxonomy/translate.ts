import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You translate post titles to English for display on an English-language site. For each \
numbered title:
- If it's already in English, return it completely unchanged — do not paraphrase, "clean up", or fix it.
- Otherwise, translate it to natural English. Keep technical terms, product names, and proper nouns that were
  already in Latin script untouched (e.g. "MCP Server", "Claude Code", people's names) rather than translating
  them literally.
- Preserve emoji and punctuation style.

Return exactly one output per input, matched by index, same order not required.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          text: { type: "string" },
        },
        required: ["index", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["titles"],
  additionalProperties: false,
} as const;

/**
 * Display-only translation — never used for tagging, which always matches
 * against the original `title` regardless of language (see taxonomy/match.ts
 * and semanticMatch.ts). Called from export.ts, and only on the handful of
 * posts about to actually be shown as a trend reference, not the full
 * ingested backlog — keeps this cheap even though it's a real model call.
 *
 * No-ops (returns input unchanged) without ANTHROPIC_API_KEY, same pattern
 * as every other optional-credential path in this pipeline — a missing key
 * here just means references stay in their original language, not a
 * failure.
 */
export async function translateTitles(titles: string[]): Promise<string[]> {
  if (titles.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY) return titles;

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: titles.map((t, i) => `${i}: ${t}`).join("\n") }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    });
  } catch (err) {
    // A provider hiccup here must never block export/sync — same reasoning
    // as semanticMatch.ts's Voyage failure handling.
    console.warn(`Translate call failed, leaving titles as-is: ${(err as Error).message}`);
    return titles;
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) return titles;

  const result = [...titles];
  try {
    const parsed = JSON.parse(textBlock.text) as { titles: { index: number; text: string }[] };
    for (const t of parsed.titles) {
      if (t.index >= 0 && t.index < result.length) result[t.index] = t.text;
    }
  } catch {
    return titles;
  }
  return result;
}
