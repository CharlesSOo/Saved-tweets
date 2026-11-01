import { fetchLinks } from "./fetchLink.ts";
import { runCli } from "./cli.ts";

export interface TweetRecord {
  id: string;
  url: string;
  author: string;
  handle: string;
  text: string;
  thread?: string;
  quoted?: string;
  links?: string[];
}

const DEFAULT_INSTRUCTIONS = "Write a 1–2 sentence TL;DR.";
const TIMEOUT_MS = 60_000;

export function systemPrompt(instructions?: string): string {
  return [
    "You summarize a tweet the user bookmarked on X.",
    "Rules:",
    "- Ground everything in the provided tweet, thread, quoted tweet and linked pages. Do not invent facts, numbers or claims.",
    "- Output only the summary as Markdown (paragraphs, bullets, **bold**, links allowed). No preamble, no headings like 'Summary'.",
    "",
    "The user's instructions for shaping the summary:",
    instructions?.trim() || DEFAULT_INSTRUCTIONS,
  ].join("\n");
}

async function buildPrompt(t: TweetRecord): Promise<string> {
  const parts = [`Tweet by ${t.author} (${t.handle}) ${t.url}`, `Text:\n${t.text}`];
  if (t.thread) parts.push(`Thread:\n${t.thread}`);
  if (t.quoted) parts.push(`Quoted tweet:\n${t.quoted}`);
  for (const l of await fetchLinks(t.links ?? [])) parts.push(`Linked page ${l.url}:\n${l.text}`);
  return parts.join("\n\n");
}

export async function summarize(t: TweetRecord, instructions?: string): Promise<{ summary: string }> {
  const summary = await runCli({ system: systemPrompt(instructions), prompt: await buildPrompt(t) }, TIMEOUT_MS);
  return { summary };
}
