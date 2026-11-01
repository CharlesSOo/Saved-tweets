// Bookmark Sync service worker: storage, summarization, and all X API calls (no tabs are ever opened on X).
importScripts('normalize.js', 'discover.js');
const N = globalThis.BookmarkSyncNormalize;
const D = globalThis.BookmarkSyncDiscover;
const SERVER = 'http://127.0.0.1:7391';
const LOGGED_OUT = 'Log in to x.com';
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_VIEWER_SYNC_MS = 5 * 60 * 1000;
const MAX_SYNC = 2000;
const STALE_SYNC_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTweets() {
  return (await chrome.storage.local.get('tweets')).tweets || {};
}

// Serialize read-modify-write on `tweets` so concurrent saves don't clobber each other.
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const tweets = await getTweets();
    const result = fn(tweets);
    await chrome.storage.local.set({ tweets });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// ---------------- X GraphQL API ----------------

// xApi = { discovered: { ops, bearer, at }, learned: { ops, bearer } }.
// `discovered` comes from x.com's HTML + JS bundles; `learned` from real page traffic (inject.js) and wins.
async function learnApi({ op, queryId, features, fieldToggles, bearer }) {
  const { xApi = {} } = await chrome.storage.local.get('xApi');
  const learned = xApi.learned || { ops: {} };
  const prev = learned.ops[op];
  if (prev?.queryId === queryId && prev.features === features && prev.fieldToggles === fieldToggles && learned.bearer === bearer) return;
  learned.ops[op] = { queryId, features, fieldToggles };
  learned.bearer = bearer;
  await chrome.storage.local.set({ xApi: { ...xApi, learned } });
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

let discovering = null;
function discoverApi() {
  discovering ||= (async () => {
    let page = null;
    for (const url of ['https://x.com/', 'https://x.com/home']) {
      page = D.parseHtml(await fetchText(url));
      if (page.mainUrl) break;
    }
    if (!page.mainUrl) throw new Error('Could not find X\'s web bundle (logged out, or X changed its web app)');
    const main = D.parseBundle(await fetchText(page.mainUrl));
    const found = { ...main.ops };
    for (const op of ['Bookmarks', 'TweetDetail']) {
      for (const url of D.chunksFor(op, page.chunks)) {
        if (found[op]) break;
        try { Object.assign(found, D.parseBundle(await fetchText(url)).ops); } catch { /* try next chunk */ }
      }
    }
    if (!main.bearer) throw new Error('Could not find X\'s bearer token in its web bundle');
    const ops = {};
    for (const op of ['Bookmarks', 'TweetDetail']) if (found[op]) ops[op] = D.buildParams(found[op], page.featureConfig);
    const { xApi = {} } = await chrome.storage.local.get('xApi');
    await chrome.storage.local.set({ xApi: { ...xApi, discovered: { ops, bearer: main.bearer, at: Date.now() } } });
  })().finally(() => { discovering = null; });
  return discovering;
}

async function apiConfig(op) {
  let { xApi = {} } = await chrome.storage.local.get('xApi');
  if (xApi.learned?.ops?.[op] && xApi.learned.bearer) return { ...xApi.learned.ops[op], bearer: xApi.learned.bearer };
  if (!xApi.discovered?.ops?.[op] || Date.now() - (xApi.discovered.at || 0) > DISCOVERY_TTL_MS) {
    await discoverApi();
    ({ xApi = {} } = await chrome.storage.local.get('xApi'));
  }
  const cfg = xApi.discovered?.ops?.[op];
  if (!cfg) throw new Error(`Could not find X's ${op} query in its web bundles`);
  return { ...cfg, bearer: xApi.discovered.bearer };
}

// After a 400/404 (rotated queryId or missing feature): forget learned values for the op and rediscover.
async function invalidateApi(op) {
  const { xApi = {} } = await chrome.storage.local.get('xApi');
  if (xApi.learned?.ops?.[op]) delete xApi.learned.ops[op];
  await chrome.storage.local.set({ xApi });
  await discoverApi();
}

async function sessionCookie() {
  const [ct0, auth] = await Promise.all([
    chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }),
    chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }),
  ]);
  const loggedOut = !ct0?.value || !auth?.value;
  const { loggedOut: was } = await chrome.storage.local.get('loggedOut');
  if (!!was !== loggedOut) await chrome.storage.local.set({ loggedOut });
  if (loggedOut) throw new Error(LOGGED_OUT);
  return ct0.value;
}

// Runs inside an already-open x.com tab (MAIN world) when the worker's own request isn't authenticated.
function fetchInPage(url, headers) {
  return fetch(url, { credentials: 'include', headers })
    .then(async (r) => ({ status: r.status, text: await r.text(), reset: r.headers.get('x-rate-limit-reset') }));
}

async function xGraphql(op, variables, retried = false) {
  const ct0 = await sessionCookie();
  const cfg = await apiConfig(op);
  const qs = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (cfg.features) qs.set('features', cfg.features);
  if (cfg.fieldToggles) qs.set('fieldToggles', cfg.fieldToggles);
  const url = `https://x.com/i/api/graphql/${cfg.queryId}/${op}?${qs}`;
  const headers = {
    authorization: cfg.bearer,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
  };

  let status = 0;
  let text = '';
  let reset = null;
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    status = res.status;
    text = await res.text();
    reset = res.headers.get('x-rate-limit-reset');
  } catch (e) {
    text = String(e);
  }
  if (status === 401 || status === 403 || status === 0) {
    // Optional fallback: same request from an already-open x.com tab, if any. Never opens a tab.
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    if (tab) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: fetchInPage, args: [url, headers] });
      ({ status, text, reset } = res.result);
    }
  }
  if ((status === 400 || status === 404) && !retried) {
    await invalidateApi(op);
    return xGraphql(op, variables, true);
  }
  if (status === 429) {
    const err = new Error('X rate limit hit');
    err.resetAt = reset ? Number(reset) * 1000 : Date.now() + 15 * 60 * 1000;
    throw err;
  }
  if (status < 200 || status >= 300) throw new Error(`X ${op} failed: HTTP ${status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors?.length && !json.data) throw new Error(`X ${op}: ${json.errors[0].message}`);
  return json;
}

async function tweetDetail(id) {
  return xGraphql('TweetDetail', {
    focalTweetId: id, with_rux_injections: false, includePromotedContent: false, withCommunity: true,
    withQuickPromoteEligibilityTweetFields: false, withBirdwatchNotes: false, withVoice: true,
  });
}

// ---------------- Records ----------------

const normalized = (json) => {
  const byId = new Map();
  for (const raw of N.collectTweets(json)) {
    const rec = N.normalizeTweet(raw);
    if (rec && !byId.has(rec.id)) byId.set(rec.id, rec);
  }
  return byId;
};

async function save(tweet) {
  const next = await mutate((t) => {
    const existing = t[tweet.id];
    if (existing && !existing.needsFetch) {
      if (tweet.source === 'sync') return null; // never overwrite on sync
      Object.assign(existing, { ...tweet, savedAt: existing.savedAt, source: existing.source, status: existing.status });
      return existing.threadChecked && existing.status !== 'summarized' ? 'summarize' : null;
    }
    const { needsFetch, ...rest } = tweet;
    t[tweet.id] = { ...rest, savedAt: existing?.savedAt || new Date().toISOString(), status: 'pending', threadChecked: false, ...(needsFetch ? { needsFetch } : {}) };
    return 'detail';
  });
  if (next === 'summarize') enqueueSummarize(tweet.id);
  if (next === 'detail') drainDetails();
}

// ---------------- TweetDetail queue (stub content + thread) ----------------
// Every new record gets exactly one successful TweetDetail fetch (threadChecked), then is summarized.
// State lives in storage, so the queue is rebuilt from `!threadChecked` records after worker restarts.

const DETAIL_SPACING_MS = 1500;
const DETAIL_MAX_ATTEMPTS = 2;

async function fetchDetail(id) {
  const json = await tweetDetail(id);
  const rec = normalized(json).get(id);
  const thread = N.threadFromTweetDetail(json, id);
  return mutate((t) => {
    const cur = t[id];
    if (!cur) return false;
    const wasStub = !!cur.needsFetch;
    if (wasStub && rec) {
      delete cur.needsFetch;
      Object.assign(cur, rec);
    }
    const newThread = !!thread && thread !== cur.thread;
    if (thread) cur.thread = thread;
    cur.threadChecked = true;
    delete cur.detailAttempts;
    delete cur.detailError;
    if (wasStub && !rec) cur.detailError = 'Tweet not found in TweetDetail response';
    return !cur.needsFetch && (cur.status !== 'summarized' || newThread);
  });
}

let draining = false;
async function drainDetails() {
  if (draining) return;
  draining = true;
  let done = 0;
  try {
    while (true) {
      const { rateLimitedUntil = 0 } = await chrome.storage.local.get('rateLimitedUntil');
      if (Date.now() < rateLimitedUntil) {
        chrome.alarms.create('detailResume', { when: rateLimitedUntil + 1000 });
        break;
      }
      const todo = Object.values(await getTweets())
        .filter((t) => !t.threadChecked)
        .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      await chrome.storage.local.set({ detailProgress: { running: todo.length > 0, done, total: done + todo.length } });
      if (!todo.length) break;
      const { id } = todo[0];
      try {
        if (await fetchDetail(id)) enqueueSummarize(id);
      } catch (e) {
        if (e.resetAt) {
          await chrome.storage.local.set({ rateLimitedUntil: e.resetAt });
          continue; // loop sees rateLimitedUntil and schedules the resume alarm
        }
        if (e.message === LOGGED_OUT) break;
        const giveUp = await mutate((t) => {
          const cur = t[id];
          if (!cur) return false;
          cur.detailAttempts = (cur.detailAttempts || 0) + 1;
          if (cur.detailAttempts < DETAIL_MAX_ATTEMPTS) return false;
          Object.assign(cur, { threadChecked: true, detailError: `Thread/content fetch failed: ${e.message}` });
          return !cur.needsFetch && cur.status !== 'summarized';
        });
        if (giveUp) enqueueSummarize(id);
      }
      done++;
      await sleep(DETAIL_SPACING_MS);
    }
  } finally {
    draining = false;
    const { detailProgress } = await chrome.storage.local.get('detailProgress');
    if (detailProgress?.running) await chrome.storage.local.set({ detailProgress: { ...detailProgress, running: false } });
  }
}

// ---------------- Summaries ----------------

async function summarize(id) {
  const tweet = (await getTweets())[id];
  if (!tweet || tweet.needsFetch || tweet.status === 'summarized') return;
  await mutate((t) => { if (t[id]) t[id].summarizing = true; });
  let res;
  try {
    res = await fetch(`${SERVER}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tweet, instructions: (await chrome.storage.local.get('summaryInstructions')).summaryInstructions || '' }),
    });
  } catch {
    await chrome.storage.local.set({ serverDown: true });
    await mutate((t) => { if (t[id]) Object.assign(t[id], { status: 'pending', summarizing: false }); });
    return;
  }
  await chrome.storage.local.set({ serverDown: false });
  if (res.ok) {
    const { summary } = await res.json();
    await mutate((t) => { if (t[id]) Object.assign(t[id], { summary, status: 'summarized', error: undefined, summarizing: false }); });
  } else {
    const error = (await res.text()) || `HTTP ${res.status}`;
    await mutate((t) => { if (t[id]) Object.assign(t[id], { status: 'failed', error, summarizing: false }); });
  }
}

// Concurrency-2 summarize queue (local server, not X). `queued` holds queued + in-flight ids, so an id
// is never enqueued twice; summarize() also skips records that are already summarized.
const summarizeQueue = [];
const queued = new Set();
let workers = 0;
function enqueueSummarize(id) {
  if (queued.has(id)) return;
  queued.add(id);
  summarizeQueue.push(id);
  pumpSummaries();
}
function pumpSummaries() {
  while (workers < 2 && summarizeQueue.length) {
    const id = summarizeQueue.shift();
    workers++;
    summarize(id).catch(() => {}).finally(() => {
      queued.delete(id);
      workers--;
      pumpSummaries();
    });
  }
}

async function resummarizeAll() {
  const ids = await mutate((t) => Object.values(t).filter((r) => !r.needsFetch).map((r) => { r.status = 'pending'; return r.id; }));
  for (const id of ids) if ((await getTweets())[id]?.threadChecked) enqueueSummarize(id);
}

async function summarizePending() {
  for (const t of Object.values(await getTweets())) {
    if (t.threadChecked && !t.needsFetch && t.status !== 'summarized') enqueueSummarize(t.id);
  }
  drainDetails();
}

// ---------------- Sync ----------------

async function syncBookmarks() {
  const { syncStatus, fullSyncDone } = await chrome.storage.local.get(['syncStatus', 'fullSyncDone']);
  if (syncStatus?.running && Date.now() - (syncStatus.startedAt || 0) < STALE_SYNC_MS) return { error: 'Sync already running' };
  const full = !fullSyncDone;
  const status = { running: true, full, count: 0, added: 0, startedAt: Date.now() };
  await chrome.storage.local.set({ syncStatus: status });
  let error;
  try {
    const seen = new Set();
    let cursor;
    while (seen.size < MAX_SYNC) {
      const json = await xGraphql('Bookmarks', { count: 100, includePromotedContent: false, ...(cursor ? { cursor } : {}) });
      const ids = N.entryTweetIds(json);
      const recs = normalized(json);
      const stored = await getTweets();
      const fresh = ids.filter((id) => !seen.has(id));
      if (!fresh.length) break;
      let pageAlreadyStored = true;
      for (const id of fresh) {
        seen.add(id);
        if (!stored[id] || stored[id].needsFetch) pageAlreadyStored = false;
        const rec = recs.get(id);
        if (rec && (!stored[id] || stored[id].needsFetch)) { await save({ ...rec, source: 'sync' }); status.added++; }
      }
      status.count = seen.size;
      await chrome.storage.local.set({ syncStatus: { ...status } });
      if (!full && pageAlreadyStored) break;
      cursor = N.bottomCursor(json);
      if (!cursor) break;
      await sleep(1000);
    }
    if (full) await chrome.storage.local.set({ fullSyncDone: true });
    return { ok: true, count: status.count, added: status.added };
  } catch (e) {
    error = e.message;
    return { error };
  } finally {
    await chrome.storage.local.set({ syncStatus: { ...status, running: false, error, finishedAt: Date.now() } });
    pushStore({ force: true });
    drainDetails();
  }
}

async function syncIfStale() {
  const { syncStatus } = await chrome.storage.local.get('syncStatus');
  if (!syncStatus?.finishedAt || Date.now() - syncStatus.finishedAt > STALE_VIEWER_SYNC_MS) return syncBookmarks();
  return { ok: true, skipped: true };
}

// Background loop while Chrome is open: alarm-driven, independent of the viewer.
const SYNC_PERIOD_MIN = 10;
async function ensureAlarm() {
  const a = await chrome.alarms.get('autoSync');
  if (!a || a.periodInMinutes !== SYNC_PERIOD_MIN) await chrome.alarms.create('autoSync', { periodInMinutes: SYNC_PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await mutate((t) => {
    for (const r of Object.values(t)) {
      delete r.tags; // tags were dropped
      if ('tldr' in r) { r.summary ??= r.tldr; delete r.tldr; } // tldr -> summary rename
    }
  });
  pushStore({ force: true });
  syncBookmarks(); // drains the detail queue when done
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  pushStore({ force: true });
  syncBookmarks();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSync') syncBookmarks(); // its finally pushes the store
  if (a.name === 'detailResume') drainDetails();
});

// ---------------- Click capture: X's CreateBookmark mutation ----------------

async function onCreateBookmark(id, tabId) {
  let tweet = null;
  if (tabId >= 0) {
    try { tweet = (await chrome.tabs.sendMessage(tabId, { type: 'getTweet', id }))?.tweet || null; } catch {}
  }
  if (tweet) return save({ ...tweet, source: 'click' });
  await save({ id, url: `https://x.com/i/web/status/${id}`, author: '', handle: '', text: '', media: [], links: [], createdAt: new Date().toISOString(), source: 'click', needsFetch: true });
}

function bookmarkIdFrom(details) {
  try {
    const bytes = details.requestBody?.raw?.[0]?.bytes;
    return bytes ? String(JSON.parse(new TextDecoder().decode(bytes)).variables?.tweet_id || '') : '';
  } catch { return ''; }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    const id = bookmarkIdFrom(details);
    if (id) onCreateBookmark(id, details.tabId);
  },
  { urls: ['https://x.com/i/api/graphql/*/CreateBookmark', 'https://twitter.com/i/api/graphql/*/CreateBookmark'] },
  ['requestBody'],
);
// DeleteBookmark is deliberately ignored: removing a bookmark on X never deletes it locally.

// ---------------- Server store (bookmarks.jsonl for chat) ----------------
// Always a full replace (records are small). A relevant change sets the durable `storeDirty` flag and
// schedules a 2s-debounced push; the flag survives worker restarts and is retried on every trigger.

const STORE_FIELDS = ['url', 'author', 'handle', 'text', 'thread', 'quoted', 'links', 'summary', 'createdAt'];
const storeKey = (r) => JSON.stringify(STORE_FIELDS.map((k) => r[k]));
let pushTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tweets) return;
  const before = changes.tweets.oldValue || {};
  const after = changes.tweets.newValue || {};
  const changed = Object.keys(before).some((id) => !(id in after))
    || Object.entries(after).some(([id, r]) => !before[id] || storeKey(before[id]) !== storeKey(r));
  if (!changed) return;
  chrome.storage.local.set({ storeDirty: true });
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushStore(), 2000);
});

let pushing = null;
async function pushStore({ force = false } = {}) {
  clearTimeout(pushTimer);
  if (pushing) return pushing;
  pushing = (async () => {
    const { storeDirty } = await chrome.storage.local.get('storeDirty');
    if (!force && !storeDirty) return;
    const records = Object.values(await getTweets())
      .filter((r) => !r.needsFetch)
      .map((r) => ({ id: r.id, ...Object.fromEntries(STORE_FIELDS.map((k) => [k, r[k]])) }));
    try {
      const res = await fetch(`${SERVER}/store?replace=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(records) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await chrome.storage.local.set({ storeDirty: false });
    } catch (e) {
      console.warn('[store] push failed, will retry on next trigger:', e.message);
      await chrome.storage.local.set({ storeDirty: true });
    }
  })().finally(() => { pushing = null; });
  return pushing;
}

pushStore(); // every worker start: flush a push that was pending when the previous worker died
// A fresh worker has nothing in flight: clear `summarizing` left behind by a worker that died mid-request,
// and requeue those records.
mutate((t) => Object.values(t).filter((r) => r.summarizing).map((r) => { r.summarizing = false; return r.id; }))
  .then((ids) => ids.forEach(enqueueSummarize));

// ---------------- Export / messages ----------------

function toMarkdown(tweets) {
  return Object.values(tweets)
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
    .map((t) => {
      const lines = [`## ${t.author} (${t.handle}) — ${(t.createdAt || '').slice(0, 10)}`, '', t.url, '', t.thread || t.text];
      if (t.summary) lines.push('', '**Summary:**', '', t.summary);
      return lines.join('\n');
    })
    .join('\n\n');
}

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('bookmarks.html') }));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'save': await save(msg.tweet); return { ok: true };
      case 'xApi': await learnApi(msg); return { ok: true };
      case 'summarize': // manual re-run
        await mutate((t) => { if (t[msg.id]) t[msg.id].status = 'pending'; });
        enqueueSummarize(msg.id);
        return { ok: true };
      case 'summarizePending': await summarizePending(); return { ok: true };
      case 'resummarizeAll': await resummarizeAll(); return { ok: true };
      case 'syncBookmarks': return syncBookmarks();
      case 'syncIfStale': return syncIfStale();
      case 'delete': await mutate((t) => { delete t[msg.id]; }); return { ok: true };
      case 'export': {
        const tweets = await getTweets();
        return msg.format === 'markdown'
          ? { content: toMarkdown(tweets) }
          : { content: JSON.stringify(Object.values(tweets), null, 2) };
      }
      default: return { error: 'unknown message' };
    }
  };
  handle().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
