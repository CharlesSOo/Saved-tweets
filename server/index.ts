import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { summarize, type TweetRecord } from "./summarize.ts";
import { upsert, remove, type StoredRecord } from "./store.ts";
import { chat } from "./chat.ts";

const PORT = 7391;
const app = new Hono();

app.use("*", cors({ origin: (origin) => (origin.startsWith("chrome-extension://") ? origin : null) }));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/summarize", async (c) => {
  let body: TweetRecord & { instructions?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON body", 400);
  }
  if (!body?.text && !body?.thread) return c.text("Tweet record needs text", 400);
  const { instructions, ...tweet } = body;
  try {
    const result = await summarize(tweet, instructions);
    console.log(`[summarize] ${tweet.id} ok`);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[summarize] ${tweet.id} failed: ${msg}`);
    return c.text(msg, 502);
  }
});

app.post("/store", async (c) => {
  let body: StoredRecord | StoredRecord[];
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON body", 400);
  }
  const total = await upsert(Array.isArray(body) ? body : [body], c.req.query("replace") === "1");
  return c.json({ ok: true, total });
});

app.delete("/store/:id", async (c) => c.json({ ok: true, removed: await remove(c.req.param("id")) }));

app.post("/chat", async (c) => {
  let body: { message?: string; sessionId?: string; instructions?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON body", 400);
  }
  if (!body.message?.trim()) return c.text("message required", 400);
  c.header("Content-Type", "text/plain; charset=utf-8");
  return stream(c, async (s) => {
    try {
      for await (const chunk of chat(body.message!, body.sessionId, body.instructions)) await s.write(chunk);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[chat] failed: ${msg}`);
      await s.write(`\n\n**Error:** ${msg}`);
    }
  });
});

Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch, idleTimeout: 255 });
console.log(`Bookmark Sync server on http://127.0.0.1:${PORT}`);
