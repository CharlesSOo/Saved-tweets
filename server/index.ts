import { Hono } from "hono";
import { cors } from "hono/cors";
import { summarize, type TweetRecord } from "./summarize.ts";

const PORT = 7391;
const app = new Hono();

app.use("*", cors({ origin: (origin) => (origin.startsWith("chrome-extension://") ? origin : null) }));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/summarize", async (c) => {
  let tweet: TweetRecord;
  try {
    tweet = await c.req.json<TweetRecord>();
  } catch {
    return c.text("Invalid JSON body", 400);
  }
  if (!tweet?.text && !tweet?.thread) return c.text("Tweet record needs text", 400);
  try {
    const result = await summarize(tweet);
    console.log(`[summarize] ${tweet.id} ok`);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[summarize] ${tweet.id} failed: ${msg}`);
    return c.text(msg, 502);
  }
});

Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch, idleTimeout: 120 });
console.log(`Bookmark Sync server on http://127.0.0.1:${PORT}`);
