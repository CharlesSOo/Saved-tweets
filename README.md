# Bookmark Sync

Chrome extension (MV3) that captures your X/Twitter bookmarks into `chrome.storage.local`, plus a local Bun/Hono server that summarizes each one (a TL;DR) with `pi` (or `claude`).

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
5. Open x.com once (logged in) and browse your bookmarks or any tweet, so the extension can learn X's API parameters.
6. Click the toolbar icon to open the bookmarks viewer.

The viewer's CSS (`extension/bookmarks.css`) is compiled from `extension/styles.css` with Tailwind v4 + daisyUI 5 and is committed, so loading unpacked needs no build. After changing `bookmarks.html`/`bookmarks.js` classes or `styles.css`:
```sh
cd extension && bun install && bun run build:css
```

## Environment variables (server)

| Var | Effect |
| --- | --- |
| `BOOKMARK_SYNC_MODEL` | Passed as `--model` to the CLI |
| `BOOKMARK_SYNC_CLI=claude` | Use `claude -p --output-format json` instead of `pi -p --no-tools` |

## How it works

No tab is ever opened on X. All X data fetching happens in the service worker.

- **Learning the API:** `inject.js` (page MAIN world) watches X's own GraphQL traffic. For `Bookmarks` and `TweetDetail` it forwards the queryId, `features`, `fieldToggles`, and the `authorization` bearer; the worker stores them in `chrome.storage.local.xApi` and refreshes them whenever X rotates them. Until this has happened once, the viewer shows "Open x.com once so Bookmark Sync can learn X's API" and sync/thread fetches return that error.
- **Calling X:** the worker reads the `ct0` cookie and calls `https://x.com/i/api/graphql/<queryId>/<Op>` with the learned parameters and `credentials: 'include'`. If that comes back 401/403 or fails, it retries the same request inside an already-open x.com tab via `chrome.scripting.executeScript` (MAIN world). With no x.com tab open, the error is reported.
- **Click capture:** the worker watches the `CreateBookmark` request (`chrome.webRequest`) for `variables.tweet_id`. `DeleteBookmark` is ignored, so un-bookmarking on X never deletes locally. Content comes from the tab's cache of tweets parsed from X's GraphQL responses, then the tab's DOM, then a `TweetDetail` call from the worker. If all fail, a stub ("content not captured") is stored; "Summarize pending" and the card's "Fetch content" retry it.
- **Sync:** `Bookmarks` with `count: 100`, paging on the `cursor-bottom` entry with ~1s between pages, up to 2000 tweets. The first sync is full; later syncs stop at the first page that is entirely already stored. Existing records are never overwritten. An alarm runs an incremental sync every 30 minutes (once the API is learned).
- **Threads:** "Fetch thread" in a card's ⋯ menu, and automatically before summarizing when the text ends with a thread marker (`🧵`, `1/`, `(1/`, `Thread:`, `a thread`). Uses `TweetDetail` and keeps the root plus the author's consecutive self-replies.
- **Summaries:** each new record is queued (2 at a time) and POSTed to `127.0.0.1:7391/summarize`. The server fetches up to 3 external links with `curl_chrome` and returns `{tldr}`. If the server is unreachable the record stays pending and the viewer shows a banner with Retry.
- **Export:** JSON (all records) or Markdown (one section per tweet), from the top bar's ⋯ menu.

## Tests

```sh
cd extension && bun test   # GraphQL normalizer
```

## Limitations

- Depends on X's private GraphQL operation names, parameters and payload shapes (`CreateBookmark`, `Bookmarks`, `TweetDetail`, `note_tweet`, `legacy.entities`). These change without notice; queryIds are re-learned automatically, shape changes are not.
- Heavy syncing uses your logged-in X session and is subject to X's rate limits.
- The DOM fallback relies on `data-testid` attributes and can only partially recover truncated t.co links.
- Bookmarking a tweet that arrived in a response type not listed above (e.g. a list or notifications timeline) falls back to the DOM, or to a stub.
