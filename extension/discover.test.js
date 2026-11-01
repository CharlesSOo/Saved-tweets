// Fixtures are verbatim excerpts of X's real web bundles (main.1e03d4dd38cf6a4fa.js and
// shared~bundle.BookmarkFolders~bundle.Bookmarks.a6452ad138fd8a60a.js, fetched 2026-11-01).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
const D = require('./discover.js');
const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('parseBundle: TweetDetail and bearer from main.js', () => {
  const { ops, bearer } = D.parseBundle(fixture('main.snippet.js'));
  expect(ops.TweetDetail.queryId).toBe('qpemjmVMoTWDvcRT43JIVQ');
  expect(ops.TweetDetail.featureSwitches).toContain('rweb_video_screen_enabled');
  expect(ops.TweetDetail.fieldToggles.length).toBeGreaterThan(0);
  expect(bearer).toBe('Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA');
});

test('parseBundle: Bookmarks from its lazy chunk', () => {
  const { ops } = D.parseBundle(fixture('bookmarks-chunk.snippet.js'));
  expect(ops.Bookmarks.queryId).toBe('jbqsfdzI0EMFHAtpEC6vyA');
  expect(ops.Bookmarks.featureSwitches.length).toBeGreaterThan(10);
  expect(ops.bookmarkTweetToFolder.queryId).toBe('4KHZvvNbHNf07bsgnL9gWA');
});

test('parseHtml: main URL, chunk map, feature config (synthetic logged-in shell)', () => {
  const html = `<script src="https://abs.twimg.com/responsive-web/client-web/main.1e03d4dd38cf6a4fa.js"></script>
<script>window.__INITIAL_STATE__={"featureSwitch":{"defaultConfig":{"rweb_video_screen_enabled":{"value":false},"x":{"value":true}},"user":{"config":{"x":{"value":false}}}}};window.__META_DATA__={};</script>
<script>n.u=e=>e+"."+{"shared~bundle.BookmarkFolders~bundle.Bookmarks":"a6452ad138fd8a60","bundle.Bookmarks":"79c2a9faf5cc127c","bundle.Conversation":"0123abcd"}[e]+"a.js"</script>`;
  const { mainUrl, chunks, featureConfig } = D.parseHtml(html);
  expect(mainUrl).toBe('https://abs.twimg.com/responsive-web/client-web/main.1e03d4dd38cf6a4fa.js');
  expect(D.chunksFor('Bookmarks', chunks)).toEqual([
    'https://abs.twimg.com/responsive-web/client-web/shared~bundle.BookmarkFolders~bundle.Bookmarks.a6452ad138fd8a60a.js',
    'https://abs.twimg.com/responsive-web/client-web/bundle.Bookmarks.79c2a9faf5cc127ca.js',
  ]);
  expect(featureConfig).toEqual({ rweb_video_screen_enabled: false, x: false });
});

test('buildParams: config values win, unknown switches default to true', () => {
  const p = D.buildParams({ queryId: 'q', featureSwitches: ['a', 'b'], fieldToggles: ['t'] }, { a: false });
  expect(p).toEqual({ queryId: 'q', features: '{"a":false,"b":true}', fieldToggles: '{"t":true}' });
});
