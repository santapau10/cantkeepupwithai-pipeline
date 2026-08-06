import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../lib/prisma.js";
import { groupTodaysTopStories, type PostGroup } from "./group.js";

const SYSTEM_PROMPT = `You are the editorial synthesis step for cantkeepupwithai.com, a daily digest of what \
the AI world is talking about. You are given pre-grouped clusters of posts — the grouping (which posts belong \
together) has already been decided deterministically by shared trend tag; your only job is to write the story.

For each group you choose to cover, write:
- headline: a single sentence, specific, no clickbait
- summary: one paragraph synthesizing what the posts are actually saying, in your own words
- whyItMatters: one sentence on why this matters, not a restatement of the summary

Ground every claim in the provided posts. Do not invent details not present in the titles/sources given. \
Pick the 3-5 most substantive groups — skip a group if it doesn't have enough signal for a real story.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trendName: { type: "string" },
          headline: { type: "string" },
          summary: { type: "string" },
          whyItMatters: { type: "string" },
          sourcePostIds: { type: "array", items: { type: "string" } },
        },
        required: ["trendName", "headline", "summary", "whyItMatters", "sourcePostIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["stories"],
  additionalProperties: false,
} as const;

type SynthesisOutput = {
  stories: {
    trendName: string;
    headline: string;
    summary: string;
    whyItMatters: string;
    sourcePostIds: string[];
  }[];
};

function formatGroupsForPrompt(groups: PostGroup[]) {
  return groups
    .map(
      (g) =>
        `## ${g.trendName} (${g.tag})\n` +
        g.posts.map((p) => `- [${p.id}] (${p.sourceName}, score ${p.score}) ${p.title} — ${p.url}`).join("\n"),
    )
    .join("\n\n");
}

/** The one indispensable model call in the pipeline — everything upstream is deterministic. */
export async function synthesizeDigest() {
  const groups = await groupTodaysTopStories();
  if (groups.length === 0) {
    return { storiesCreated: 0, note: "No grouped posts in the last 24h to synthesize from." };
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4000,
    // No prompt caching here on purpose: this runs once a day, well past
    // any cache TTL, so a cache breakpoint would only add the write premium
    // with no read ever hitting it.
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: formatGroupsForPrompt(groups) }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("Synthesis call returned no text content");

  const parsed = JSON.parse(textBlock.text) as SynthesisOutput;
  const digestDate = new Date();
  digestDate.setUTCHours(0, 0, 0, 0);

  for (const story of parsed.stories) {
    await prisma.storyDraft.create({
      data: {
        digestDate,
        headline: story.headline,
        summary: story.summary,
        whyItMatters: story.whyItMatters,
        sourcePostIds: JSON.stringify(story.sourcePostIds),
        status: "draft",
      },
    });
  }

  return { storiesCreated: parsed.stories.length };
}
