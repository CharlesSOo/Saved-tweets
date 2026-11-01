import { mkdir } from "node:fs/promises";
import { streamCli } from "./cli.ts";
import { DATA_DIR } from "./store.ts";

const TIMEOUT_MS = 120_000;
const MAX_TURNS = 20;

interface Turn { user: string; assistant: string }
const sessions = new Map<string, Turn[]>();

function systemPrompt(instructions?: string): string {
  return [
    "You answer questions about the user's saved X (Twitter) bookmarks.",
    "The working directory contains bookmarks.jsonl: one JSON object per line with fields",
    "id, url, author, handle, text, thread, quoted, links, summary, createdAt.",
    "",
    "How to work:",
    "- Search with grep (case-insensitive, several related keywords) across bookmarks.jsonl; the text, thread and summary fields are where content lives. Read matching lines before answering.",
    "- Base the answer only on bookmarks you actually found. If nothing relevant exists, say so.",
    "- Cite every bookmark you rely on inline as [[tweet:<id>]] using its id field. Do not print raw JSON or file paths.",
    "- Answer in Markdown.",
    ...(instructions?.trim() ? ["", "About the user (their own description and preferences):", instructions.trim()] : []),
  ].join("\n");
}

function prompt(history: Turn[], message: string): string {
  if (!history.length) return message;
  const transcript = history.map((t) => `User: ${t.user}\n\nAssistant: ${t.assistant}`).join("\n\n---\n\n");
  return `Conversation so far:\n\n${transcript}\n\n---\n\nUser's new message:\n${message}`;
}

export async function* chat(message: string, sessionId?: string, instructions?: string): AsyncGenerator<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const history = (sessionId && sessions.get(sessionId)) || [];
  let answer = "";
  for await (const chunk of streamCli({ system: systemPrompt(instructions), prompt: prompt(history, message), readOnlyTools: true, cwd: DATA_DIR }, TIMEOUT_MS)) {
    answer += chunk;
    yield chunk;
  }
  if (sessionId) sessions.set(sessionId, [...history, { user: message, assistant: answer.trim() }].slice(-MAX_TURNS));
}
