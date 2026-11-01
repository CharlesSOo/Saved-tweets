// Pure helpers that discover X's web GraphQL parameters from x.com's HTML and JS bundles,
// the way twitter-api-client and similar libraries do. Used by background.js; tested by discover.test.js.
(() => {
  const CDN = 'https://abs.twimg.com/responsive-web/client-web';
  // Which lazy chunks to search, by chunk-name substring, when an op is not in main.js.
  const CHUNK_HINTS = { Bookmarks: 'bundle.Bookmarks', TweetDetail: 'bundle.Conversation' };

  // From x.com HTML: main bundle URL, lazy chunk URLs (webpack name -> hash map), feature-switch config.
  function parseHtml(html) {
    const mainUrl = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/main\.[0-9a-f]+\.js/)?.[0] || null;
    const chunks = {};
    for (const m of html.matchAll(/"((?:shared~|bundle\.|ondemand\.|loader\.)[\w.~-]+)":"([0-9a-f]{6,})"/g)) {
      chunks[m[1]] = `${CDN}/${m[1]}.${m[2]}a.js`;
    }
    let featureConfig = {};
    const state = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/)?.[1];
    if (state) {
      try {
        const fs = JSON.parse(state).featureSwitch || {};
        for (const src of [fs.defaultConfig, fs.user?.config]) {
          for (const [k, v] of Object.entries(src || {})) if (v && 'value' in v) featureConfig[k] = v.value;
        }
      } catch { featureConfig = {}; }
    }
    return { mainUrl, chunks, featureConfig };
  }

  const names = (list) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // From a JS bundle: GraphQL op definitions and the web client's bearer token.
  function parseBundle(js) {
    const ops = {};
    const re = /queryId:"([^"]+)",operationName:"(\w+)",operationType:"\w+",metadata:\{featureSwitches:\[([^\]]*)\](?:,fieldToggles:\[([^\]]*)\])?/g;
    for (const m of js.matchAll(re)) {
      ops[m[2]] = { queryId: m[1], featureSwitches: names(m[3]), fieldToggles: names(m[4] || '') };
    }
    const bearer = js.match(/AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/)?.[0] || null;
    return { ops, bearer: bearer && `Bearer ${bearer}` };
  }

  // Chunk URLs worth searching for an op, most specific (shared~ chunks hold the op definitions) first.
  function chunksFor(op, chunks) {
    const hint = CHUNK_HINTS[op];
    if (!hint) return [];
    return Object.keys(chunks).filter((k) => k.includes(hint)).sort((a, b) => b.startsWith('shared~') - a.startsWith('shared~') || a.length - b.length).map((k) => chunks[k]);
  }

  // JSON strings for the `features` / `fieldToggles` query params; unknown switches default to true.
  function buildParams(op, featureConfig) {
    const features = Object.fromEntries(op.featureSwitches.map((k) => [k, k in featureConfig ? featureConfig[k] : true]));
    const fieldToggles = Object.fromEntries(op.fieldToggles.map((k) => [k, true]));
    return {
      queryId: op.queryId,
      features: JSON.stringify(features),
      fieldToggles: op.fieldToggles.length ? JSON.stringify(fieldToggles) : '',
    };
  }

  const api = { parseHtml, parseBundle, chunksFor, buildParams };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.BookmarkSyncDiscover = api;
})();
