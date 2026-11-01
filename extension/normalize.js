// Normalizes X GraphQL tweet objects into Bookmark Sync records.
// Loaded as an isolated-world content script (exposes globalThis.BookmarkSyncNormalize) and by normalize.test.js.
(() => {
  const unwrap = (r) => (r?.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);

  function userOf(tweet) {
    const u = tweet?.core?.user_results?.result || {};
    const img = u.avatar?.image_url || u.legacy?.profile_image_url_https || '';
    return {
      handle: u.core?.screen_name || u.legacy?.screen_name || '',
      name: u.core?.name || u.legacy?.name || '',
      avatar: img.replace(/_normal(\.\w+)$/, '_bigger$1'),
    };
  }

  function bodyOf(tweet) {
    const note = tweet.note_tweet?.note_tweet_results?.result;
    const legacy = tweet.legacy || {};
    const text = note?.text ?? legacy.full_text ?? '';
    const urls = [...(legacy.entities?.urls || []), ...(note?.entity_set?.urls || [])];
    const mediaTco = new Set((legacy.entities?.media || []).map((m) => m.url));
    let out = text;
    for (const m of mediaTco) out = out.split(m).join('');
    const links = [];
    for (const u of urls) {
      if (!u.url || !u.expanded_url) continue;
      out = out.split(u.url).join(u.expanded_url);
      if (!links.includes(u.expanded_url)) links.push(u.expanded_url);
    }
    return { text: out.trim(), links };
  }

  function mediaOf(tweet) {
    const out = [];
    for (const m of tweet.legacy?.extended_entities?.media || []) {
      if (m.type === 'video' || m.type === 'animated_gif') {
        const mp4 = (m.video_info?.variants || [])
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (mp4) out.push(mp4.url);
      }
      if (m.media_url_https) out.push(m.media_url_https);
    }
    return out;
  }

  function normalizeTweet(raw) {
    const tweet = unwrap(raw);
    if (!tweet?.rest_id || !tweet.legacy) return null;
    const { handle, name, avatar } = userOf(tweet);
    const { text, links } = bodyOf(tweet);
    const q = unwrap(tweet.quoted_status_result?.result);
    let quoted;
    if (q?.legacy) {
      const qu = userOf(q);
      quoted = `@${qu.handle}: ${bodyOf(q).text}`;
    }
    const created = new Date(tweet.legacy.created_at);
    return {
      id: tweet.rest_id,
      url: `https://x.com/${handle || 'i/web'}/status/${tweet.rest_id}`,
      author: name || handle,
      handle: '@' + handle,
      avatar: avatar || undefined,
      text,
      quoted,
      media: mediaOf(tweet),
      links,
      createdAt: isNaN(created) ? new Date().toISOString() : created.toISOString(),
      conversationId: tweet.legacy.conversation_id_str,
    };
  }

  // Recursively collects every Tweet object.
  function collectTweets(json, out = []) {
    if (!json || typeof json !== 'object') return out;
    if (Array.isArray(json)) { for (const x of json) collectTweets(x, out); return out; }
    // TweetWithVisibilityResults needs no special case: recursion reaches its inner .tweet (a Tweet).
    if (json.__typename === 'Tweet') out.push(json);
    for (const v of Object.values(json)) collectTweets(v, out);
    return out;
  }

  function entriesOf(json) {
    const out = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (Array.isArray(o.instructions)) {
        for (const ins of o.instructions) for (const e of ins.entries || (ins.entry ? [ins.entry] : [])) out.push(e);
        return;
      }
      Object.values(o).forEach(walk);
    })(json);
    return out;
  }

  // rest_ids of top-level tweet entries (excludes quoted tweets), e.g. one Bookmarks page.
  function entryTweetIds(json) {
    return entriesOf(json).map((e) => e.entryId?.match(/^tweet-(\d+)$/)?.[1]).filter(Boolean);
  }

  // Pagination cursor for the next (older) page of a timeline, e.g. Bookmarks.
  function bottomCursor(json) {
    const e = entriesOf(json).find((x) => x.entryId?.startsWith('cursor-bottom'));
    return e?.content?.value || e?.content?.itemContent?.value || null;
  }

  // From a TweetDetail response: root tweet text followed by consecutive same-author replies.
  function threadFromTweetDetail(json, rootId) {
    const entries = entriesOf(json);
    const resultOf = (ic) => unwrap(ic?.tweet_results?.result);
    const root = entries.map((e) => resultOf(e.content?.itemContent)).find((t) => t?.rest_id === rootId);
    if (!root) return null;
    const author = userOf(root).handle;
    const parts = [bodyOf(root).text];
    for (const e of entries) {
      if (!e.entryId?.startsWith('conversationthread-')) continue;
      let broke = false;
      for (const item of e.content?.items || []) {
        const t = resultOf(item.item?.itemContent);
        if (!t) continue;
        if (userOf(t).handle !== author) { broke = true; break; }
        parts.push(bodyOf(t).text);
      }
      // Self-replies come in the first conversation-thread module; stop at the first one that isn't purely the author.
      if (broke || parts.length > 1) break;
    }
    return parts.length > 1 ? parts.join('\n\n') : null;
  }

  const api = { normalizeTweet, collectTweets, entryTweetIds, bottomCursor, threadFromTweetDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.BookmarkSyncNormalize = api;
})();
