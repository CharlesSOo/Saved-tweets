// Run: bun test (from extension/)
import { test, expect } from 'bun:test';
const N = require('./normalize.js');

const user = (screen_name, name) => ({ result: { __typename: 'User', core: { screen_name, name }, avatar: { image_url: `https://pbs.twimg.com/profile_images/1/${screen_name}_normal.jpg` }, legacy: {} } });
const quoted = {
  __typename: 'Tweet', rest_id: '900', core: { user_results: { result: { legacy: { screen_name: 'quoter', name: 'Q', profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/q_normal.png' } } } },
  legacy: { full_text: 'Quoted body https://t.co/q1', created_at: 'Mon Oct 06 10:00:00 +0000 2025', conversation_id_str: '900',
    entities: { urls: [{ url: 'https://t.co/q1', expanded_url: 'https://example.org/q' }] } },
};
const tweet = {
  __typename: 'Tweet', rest_id: '123', core: { user_results: user('alice', 'Alice A') },
  note_tweet: { note_tweet_results: { result: { text: 'Long note with https://t.co/n1 and more', entity_set: { urls: [{ url: 'https://t.co/n1', expanded_url: 'https://note.example.com/a' }] } } } },
  legacy: {
    full_text: 'Short https://t.co/a1 https://t.co/m1', created_at: 'Wed Oct 08 12:34:56 +0000 2025', conversation_id_str: '123',
    entities: { urls: [{ url: 'https://t.co/a1', expanded_url: 'https://hono.dev' }], media: [{ url: 'https://t.co/m1' }] },
    extended_entities: { media: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/p.jpg' },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/poster.jpg', video_info: { variants: [
        { content_type: 'application/x-mpegURL', url: 'https://v/x.m3u8' },
        { content_type: 'video/mp4', bitrate: 256000, url: 'https://v/low.mp4' },
        { content_type: 'video/mp4', bitrate: 2176000, url: 'https://v/high.mp4' }] } },
    ] },
  },
  quoted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: quoted } },
};

test('normalizeTweet', () => {
  const r = N.normalizeTweet(tweet);
  expect(r.id).toBe('123');
  expect(r.handle).toBe('@alice');
  expect(r.author).toBe('Alice A');
  expect(r.url).toBe('https://x.com/alice/status/123');
  expect(r.text).toBe('Long note with https://note.example.com/a and more');
  expect(r.links).toEqual(['https://hono.dev', 'https://note.example.com/a']);
  expect(r.media).toEqual(['https://pbs.twimg.com/media/p.jpg', 'https://v/high.mp4', 'https://pbs.twimg.com/poster.jpg']);
  expect(r.quoted).toBe('@quoter: Quoted body https://example.org/q');
  expect(r.createdAt).toBe('2025-10-08T12:34:56.000Z');
  expect(r.avatar).toBe('https://pbs.twimg.com/profile_images/1/alice_bigger.jpg');
});

test('avatar from legacy profile_image_url_https', () => {
  expect(N.normalizeTweet(quoted).avatar).toBe('https://pbs.twimg.com/profile_images/2/q_bigger.png');
});

test('bottomCursor reads the cursor-bottom entry', () => {
  const page = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { entryId: 'tweet-1', content: {} },
    { entryId: 'cursor-top-1', content: { cursorType: 'Top', value: 'TOP' } },
    { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'HBaAgLX==' } },
  ] }] } } } };
  expect(N.bottomCursor(page)).toBe('HBaAgLX==');
  expect(N.bottomCursor({ data: {} })).toBeNull();
});

test('legacy text without note_tweet strips media t.co', () => {
  const { note_tweet, ...plain } = tweet;
  expect(N.normalizeTweet(plain).text).toBe('Short https://hono.dev');
});

test('collectTweets and entryTweetIds on a Bookmarks page', () => {
  const page = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { entryId: 'tweet-123', content: { itemContent: { tweet_results: { result: tweet } } } },
    { entryId: 'cursor-bottom-1', content: {} },
  ] }] } } } };
  expect(N.entryTweetIds(page)).toEqual(['123']);
  expect(N.collectTweets(page).map((t) => t.rest_id)).toEqual(['123', '900']);
});

test('threadFromTweetDetail takes leading same-author replies', () => {
  const mk = (id, handle, text) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: user(handle, handle) }, legacy: { full_text: text, created_at: 'Wed Oct 08 12:34:56 +0000 2025' } });
  const item = (t) => ({ item: { itemContent: { tweet_results: { result: t } } } });
  const detail = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: mk('1', 'alice', '1/ start') } } } },
    { entryId: 'conversationthread-2', content: { items: [item(mk('2', 'alice', '2/ middle')), item(mk('3', 'alice', '3/ end')), item(mk('4', 'bob', 'nice'))] } },
    { entryId: 'conversationthread-5', content: { items: [item(mk('5', 'alice', 'unrelated reply'))] } },
  ] }] } } };
  expect(N.threadFromTweetDetail(detail, '1')).toBe('1/ start\n\n2/ middle\n\n3/ end');
  expect(N.threadFromTweetDetail(detail, 'nope')).toBeNull();
});
