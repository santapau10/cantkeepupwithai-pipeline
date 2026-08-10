import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You write short context for an AI-trend radar aimed at people who don't want to read \
every article/tweet themselves but still want to actually understand what's happening, not just see a \
mention count go up. Given a trend name, its category tag, and a sample of real post titles currently being \
counted under that trend, write two things:

- summary: one plain-language sentence describing what this trend actually is. No jargon dump — someone
  who's never heard of it should come away knowing what it is.
- whyItMatters: one sentence on why someone tracking AI should care about it right now — the consequence or
  stakes, not a restatement of the summary.

Stay grounded in the sample titles given — don't invent specifics they don't support. Write for someone
smart but not necessarily deep in this specific sub-topic.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    whyItMatters: { type: "string" },
  },
  required: ["summary", "whyItMatters"],
  additionalProperties: false,
} as const;

export type TrendContext = { summary: string; whyItMatters: string };

/**
 * One-shot — the caller (export.ts) caches the result on TrendDefinition and
 * never asks again once both fields are set, same "generate once, cache
 * forever" pattern as label.ts's cluster naming. Fails soft (returns null)
 * on a missing key or a provider hiccup, same as translateTitles — this must
 * never block export/sync.
 */
export async function generateTrendContext(name: string, tag: string, sampleTitles: string[]): Promise<TrendContext | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (sampleTitles.length === 0) return null;

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Trend: "${name}" [${tag}]\n\nSample post titles:\n${sampleTitles.map((t) => `- ${t}`).join("\n")}`,
        },
      ],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    });
  } catch (err) {
    console.warn(`Trend context generation failed for "${name}": ${(err as Error).message}`);
    return null;
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) return null;

  try {
    return JSON.parse(textBlock.text) as TrendContext;
  } catch {
    return null;
  }
}
