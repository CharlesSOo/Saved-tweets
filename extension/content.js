// Bookmark Sync content script (isolated world). Caches tweets from X's GraphQL responses
// (relayed by inject.js) for click capture, and forwards learned API parameters to the service worker.
(() => {
  'use strict';
  const N = globalThis.BookmarkSyncNormalize;
  const CACHE_MAX = 500;
  const cache = new Map(); // rest_id -> record

  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch {}
  }

  function remember(rec) {
    cache.delete(rec.id);
    cache.set(rec.id, rec);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'bookmark-sync') return;
    const d = e.data;
    if (d.kind === 'api') {
      send({ type: 'xApi', op: d.op, queryId: d.queryId, features: d.features, fieldToggles: d.fieldToggles, bearer: d.bearer });
    } else if (d.kind === 'response') {
      for (const raw of N.collectTweets(d.json)) {
        const rec = N.normalizeTweet(raw);
        if (rec) remember(rec);
      }
    }
  });

  // DOM fallback, used only when the GraphQL cache misses a bookmarked id.
  function extractFromDom(id) {
    const link = document.querySelector(`article[data-testid="tweet"] a[href*="/status/${id}"] time`)?.closest('a');
    const article = link?.closest('article[data-testid="tweet"]');
    if (!article) return null;
    const handle = link.getAttribute('href').match(/^\/([^/]+)\/status\//)?.[1] || '';
    let name = '';
    for (const span of article.querySelectorAll('[data-testid="User-Name"] a span')) {
      const t = span.textContent?.trim();
      if (t && !t.startsWith('@') && !t.includes('·') && t.length > 1) { name = t; break; }
    }
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const links = [...(textEl?.querySelectorAll('a[href]') || [])]
      .map((a) => (a.title || a.textContent || '').trim().replace(/…$/, ''))
      .filter((t) => /^(https?:\/\/)?[\w-]+\.[\w.-]+/.test(t) && !/^(https?:\/\/)?(x|twitter)\.com/.test(t))
      .map((t) => (t.startsWith('http') ? t : 'https://' + t));
    return {
      id,
      url: `https://x.com/${handle}/status/${id}`,
      author: name || handle,
      handle: '@' + handle,
      text: textEl?.innerText || '',
      media: [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map((i) => i.src)
        .concat([...article.querySelectorAll('video[poster]')].map((v) => v.poster)),
      links,
      createdAt: article.querySelector('time')?.getAttribute('datetime') || new Date().toISOString(),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getTweet') sendResponse({ tweet: cache.get(msg.id) || extractFromDom(msg.id) || null });
  });
})();
