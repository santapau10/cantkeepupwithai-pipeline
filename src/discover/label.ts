import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You label clusters of post titles that didn't match any known AI/dev trend in a \
taxonomy. Given a list of titles that a clustering algorithm grouped together (by embedding similarity, \
already decided — not your job to re-cluster), decide:

- Is this actually a coherent, nameable trend, or just noise that happened to cluster? Be skeptical — most
  small clusters are noise, not trends.
- If it's real: a short trend name in the same style as existing entries (e.g. "Agent skills & harnesses",
  "MCP servers in production" — noun phrase, not a sentence), one tag from
  [technique, protocol, workflow, infra, tool, meta], and a one-sentence rationale.

If it's not a coherent trend, set isRealTrend to false and leave the other fields empty.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    isRealTrend: { type: "boolean" },
    suggestedName: { type: "string" },
    suggestedTag: { type: "string", enum: ["technique", "protocol", "workflow", "infra", "tool", "meta"] },
    rationale: { type: "string" },
  },
  required: ["isRealTrend", "suggestedName", "suggestedTag", "rationale"],
  additionalProperties: false,
} as const;

export type ClusterLabel = {
  isRealTrend: boolean;
  suggestedName: string;
  suggestedTag: string;
  rationale: string;
};

/**
 * Cheap classification task, not prose synthesis — Haiku 4.5 is the right
 * cost/quality tier here, unlike the digest-writing call which uses Sonnet 5.
 */
export async function labelCluster(titles: string[]): Promise<ClusterLabel> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: titles.map((t) => `- ${t}`).join("\n") }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("Cluster labeling call returned no text content");

  return JSON.parse(textBlock.text) as ClusterLabel;
}
