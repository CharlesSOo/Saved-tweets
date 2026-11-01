import { fetchLinks } from "./fetchLink.ts";

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

export interface Summary {
  tldr: string;
}

const SYSTEM_PROMPT =
  'You summarize bookmarked tweets. Respond with ONLY a JSON object, no prose, no code fences: ' +
  '{"tldr": "1-2 sentences"}';

const TIMEOUT_MS = 60_000;

async function buildPrompt(t: TweetRecord): Promise<string> {
  const parts = [`Tweet by ${t.author} (${t.handle}) ${t.url}`, `Text:\n${t.text}`];
  if (t.thread) parts.push(`Thread:\n${t.thread}`);
  if (t.quoted) parts.push(`Quoted tweet:\n${t.quoted}`);
  for (const l of await fetchLinks(t.links ?? [])) parts.push(`Linked page ${l.url}:\n${l.text}`);
  return parts.join("\n\n");
}

function command(prompt: string): { cmd: string[]; parse: (out: string) => string } {
  const model = process.env.BOOKMARK_SYNC_MODEL;
  if (process.env.BOOKMARK_SYNC_CLI === "claude") {
    const cmd = ["claude", "-p", "--output-format", "json", "--system-prompt", SYSTEM_PROMPT];
    if (model) cmd.push("--model", model);
    cmd.push(prompt);
    return { cmd, parse: (out) => String((JSON.parse(out) as { result?: unknown }).result ?? "") };
  }
  const cmd = ["pi", "-p", "--no-tools", "--no-session", "--mode", "text", "--system-prompt", SYSTEM_PROMPT];
  if (model) cmd.push("--model", model);
  cmd.push(prompt);
  return { cmd, parse: (out) => out };
}

export function parseSummary(raw: string): Summary {
  const stripped = raw.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`No JSON object in model output: ${raw.slice(0, 300)}`);
  const obj = JSON.parse(stripped.slice(start, end + 1)) as { tldr?: unknown };
  if (typeof obj.tldr !== "string") throw new Error(`Bad summary shape: ${raw.slice(0, 300)}`);
  return { tldr: obj.tldr.trim() };
}

export async function summarize(t: TweetRecord): Promise<Summary> {
  const { cmd, parse } = command(await buildPrompt(t));
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode) throw new Error(`${cmd[0]} timed out after ${TIMEOUT_MS / 1000}s`);
    if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 500)}`);
    return parseSummary(parse(out));
  } finally {
    clearTimeout(timer);
  }
}
