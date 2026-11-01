# Bookmark Sync

Chrome extension (MV3) that captures your X/Twitter bookmarks into `chrome.storage.local`, plus a local Bun/Hono server that summarizes each one and lets you chat over them with `pi` (or `claude`).

## Install

1. Server dependencies:
   ```sh
   cd server && bun install
   ```
2. Run the server in the foreground (for testing):
   ```sh
   bun run index.ts        # listens on 127.0.0.1:7391
   curl 127.0.0.1:7391/health
   ```
3. Or run it at login with launchd:
   ```sh
   cp server/com.bookmarksync.server.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.bookmarksync.server.plist
   tail -f ~/Library/Logs/bookmark-sync.log
   # stop: launchctl unload ~/Library/LaunchAgents/com.bookmarksync.server.plist
   ```
   The plist hardcodes `/opt/homebrew/bin/bun` and this repo path, and puts `~/.local/bin` (for `pi` and `curl_chrome`) on PATH. To set env vars below, add them to its `EnvironmentVariables`.
4. Load the extension: `chrome://extensions`, enable Developer mode, "Load unpacked", choose `extension/`.
5. Be logged in to x.com in this Chrome profile. Nothing else: x.com does not need to be open.
6. Click the toolbar icon to open the bookmarks viewer.

The viewer's CSS (`extension/bookmarks.css`) is compiled from `extension/styles.css` with Tailwind v4 + daisyUI 5 and is committed, so loading unpacked needs no build. After changing `bookmarks.html`/`bookmarks.js` classes or `styles.css`:
```sh
cd extension && bun install && bun run build:css
```

## Server endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `POST /summarize` | tweet record + `instructions` → `{summary}` (Markdown) |
| `POST /store[?replace=1]` | upsert record(s) into `data/bookmarks.jsonl` |
| `DELETE /store/:id` | remove a record |
| `POST /chat` | `{message, sessionId?, instructions?}` → streamed plain-text Markdown |

## Environment variables (server)

| Var | Effect |
| --- | --- |
| `BOOKMARK_SYNC_MODEL` | Passed as `--model` to the CLI |
| `BOOKMARK_SYNC_CLI=claude` | Use `claude -p --output-format text` instead of `pi` (chat then uses Read/Grep/Glob and does not stream incrementally) |

## How it works

No tab is ever opened on X. All X data fetching happens in the service worker.

- **Discovering the API:** the worker fetches `https://x.com/` (then `/home`) with your cookies, finds the `main.<hash>.js` bundle and the webpack chunk map, and regex-extracts the `queryId`, feature switches and field toggles for `Bookmarks` (from the `bundle.Bookmarks` shared chunk) and `TweetDetail` (from `main.js`), plus the web client's bearer token. Feature values come from `__INITIAL_STATE__.featureSwitch` when present, else `true`. The result is cached in `chrome.storage.local.xApi.discovered` for 24h and refreshed immediately when X answers 400/404 (one retry). Parameters seen in real x.com traffic (`inject.js`) are stored under `xApi.learned` and take precedence.
- **Calling X:** the worker reads the `ct0` and `auth_token` cookies (missing = logged out, the viewer says "Log in to x.com") and calls `https://x.com/i/api/graphql/<queryId>/<Op>` with `credentials: 'include'`. If that comes back 401/403 or fails, it retries the same request inside an already-open x.com tab via `chrome.scripting.executeScript` (MAIN world), if there is one.
- **Click capture:** the worker watches the `CreateBookmark` request (`chrome.webRequest`) for `variables.tweet_id`. `DeleteBookmark` is ignored, so un-bookmarking on X never deletes locally. Content comes from the tab's cache of tweets parsed from X's GraphQL responses, then the tab's DOM, then a `TweetDetail` call from the worker. If all fail, a stub ("content not captured") is stored and filled by the background TweetDetail queue.
- **Sync:** `Bookmarks` with `count: 100`, paging on the `cursor-bottom` entry with ~1s between pages, up to 2000 tweets. The first sync is full; later syncs stop at the first page that is entirely already stored. Existing records are never overwritten. Incremental syncs also run on browser startup, on install/update, every 10 minutes (alarm, recreated on install and startup), so it all runs while Chrome is open without the viewer, and when the viewer opens if the last sync finished more than 5 minutes ago.
- **Threads and missing content:** every new record gets one `TweetDetail` fetch in the background (concurrency 1, 1.5s apart; on HTTP 429 it pauses until `x-rate-limit-reset` via an alarm). That fills stub records and attaches the author's self-reply thread, then the record is summarized. Records with `threadChecked: false` form the queue, so it resumes after worker restarts. Two failures: summarize with what we have and note the error on the card. The viewer shows "Fetching threads n/N".
- **Summaries:** after the TweetDetail fetch, each record is POSTed (2 at a time) to `/summarize` together with your **summary instructions** (gear icon in the viewer; stored as `summaryInstructions`). The server fetches up to 3 external links with `curl_chrome`, appends your instructions to fixed grounding rules (only use the tweet, thread, quoted tweet and linked pages; don't invent facts), and returns `{summary}` as Markdown (default without instructions: a 1–2 sentence TL;DR). Changing instructions only affects new summaries; "Re-summarize all" in the settings modal re-runs everything. If the server is unreachable the record stays pending and the viewer shows a banner with Retry.
- **Chat:** the "Chat" drawer sends `{message, sessionId, instructions}` to `/chat`. The server runs `pi -p --no-session --mode json --tools read,grep,find,ls` (read-only, no bash/edit/write) with `data/` as cwd, so it greps `data/bookmarks.jsonl`, and streams the answer's text deltas back. Answers cite bookmarks as `[[tweet:<id>]]`, which the viewer renders as mini cards; clicking one scrolls to and highlights that bookmark. Conversation history (last 20 turns) is kept in server memory per session and sent as a transcript; the drawer's history is in-memory only.
- **Server store:** the extension mirrors its records to `data/bookmarks.jsonl` (gitignored) via `POST /store` (upsert; `?replace=1` for a full push) and `DELETE /store/:id`. Changes are pushed 2s debounced; a full push runs on browser startup and after each sync; if the server was down the next push is a full one.
- **Export:** JSON (all records) or Markdown (one section per tweet), from the top bar's ⋯ menu.

## Tests

```sh
cd extension && bun test   # GraphQL normalizer, API discovery, Markdown renderer (fixtures/ are excerpts of X's real bundles)
```

## Limitations

- Depends on X's private GraphQL operation names, parameters and payload shapes (`CreateBookmark`, `Bookmarks`, `TweetDetail`, `note_tweet`, `legacy.entities`). These change without notice; queryIds are rediscovered automatically, shape changes are not.
- Discovery depends on the logged-in x.com page still serving the classic `responsive-web` webpack app. The logged-out page has already moved to a new app (`x-web`, Relay persisted queries) with no `Bookmarks` query; if the logged-in page follows, discovery breaks and only parameters learned from browsing x.com will work.
- Heavy syncing uses your logged-in X session and is subject to X's rate limits.
- The DOM fallback relies on `data-testid` attributes and can only partially recover truncated t.co links.
- Bookmarking a tweet that arrived in a response type not listed above (e.g. a list or notifications timeline) falls back to the DOM, or to a stub.
