// MAIN-world: observes X GraphQL traffic. Forwards responses (for the tweet cache) and the
// request parameters of Bookmarks/TweetDetail (so the service worker can call them itself).
(() => {
  const OPS = new Set(['Bookmarks', 'TweetDetail', 'HomeTimeline', 'HomeLatestTimeline', 'UserTweets', 'SearchTimeline', 'TweetResultByRestId']);
  const API_OPS = new Set(['Bookmarks', 'TweetDetail']);
  const parse = (url) => {
    try {
      const u = new URL(String(url), location.origin);
      const m = u.pathname.match(/\/i\/api\/graphql\/([^/]+)\/([^/?]+)/);
      return m ? { queryId: m[1], op: m[2], params: u.searchParams } : null;
    } catch { return null; }
  };
  const post = (data) => window.postMessage({ source: 'bookmark-sync', ...data }, '*');

  function onRequest(url, authorization) {
    const p = parse(url);
    if (!p || !API_OPS.has(p.op) || !authorization) return;
    post({
      kind: 'api', op: p.op, queryId: p.queryId, bearer: authorization,
      features: p.params.get('features') || '', fieldToggles: p.params.get('fieldToggles') || '',
    });
  }

  function onResponse(url, body) {
    const p = parse(url);
    if (!p || !OPS.has(p.op)) return;
    let json;
    try { json = typeof body === 'string' ? JSON.parse(body) : body; } catch { return; }
    if (json) post({ kind: 'response', op: p.op, json });
  }

  function authFrom(headers) {
    if (!headers) return '';
    if (headers instanceof Headers) return headers.get('authorization') || '';
    if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'authorization') return v;
    return '';
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const graphql = url && url.includes('/i/api/graphql/');
    if (graphql) onRequest(url, authFrom(init?.headers) || (input instanceof Request ? input.headers.get('authorization') : ''));
    const res = await origFetch.call(this, input, init);
    if (graphql) res.clone().text().then((t) => onResponse(url, t), () => {});
    return res;
  };

  const { open, send, setRequestHeader } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bsUrl = url;
    this.__bsAuth = '';
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') this.__bsAuth = v;
    return setRequestHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (String(this.__bsUrl || '').includes('/i/api/graphql/')) {
      onRequest(this.__bsUrl, this.__bsAuth);
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === '' || this.responseType === 'text' ? this.responseText : this.response;
          onResponse(this.__bsUrl, body);
        } catch {}
      });
    }
    return send.apply(this, args);
  };
})();
