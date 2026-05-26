import { describe, expect, test } from 'vitest';
import { renderReply, type ReplyItem } from './render.ts';
import type { Tweet } from './fxtwitter.ts';

const baseTweet: Tweet = {
  id: '1',
  authorScreenName: 'jack',
  text: 'hello world',
  sensitive: false,
  media: 'none',
};

const mirror = 'https://xcancel.com/jack/status/1';

describe('renderReply', () => {
  test('enriched tweet: quoted text + mirror on next line', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: baseTweet }]);
    expect(out).toBe(`> **@jack**: hello world\n${mirror}`);
  });

  test('tweet with photo: media tag appended', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: { ...baseTweet, media: 'photo' } }]);
    expect(out).toBe(`> **@jack**: hello world [photo]\n${mirror}`);
  });

  test('tweet with video: media tag', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: { ...baseTweet, media: 'video' } }]);
    expect(out).toContain('[video]');
  });

  test('tweet with gif: media tag', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: { ...baseTweet, media: 'gif' } }]);
    expect(out).toContain('[gif]');
  });

  test('sensitive tweet: text suppressed, mirror + author + media only', () => {
    const out = renderReply([{
      mirrorUrl: mirror,
      tweet: { ...baseTweet, text: 'something nsfw', sensitive: true, media: 'photo' },
    }]);
    expect(out).toBe(`**@jack** [photo]\n${mirror}`);
    expect(out).not.toContain('nsfw');
  });

  test('tweet with empty text: no quote line, just author', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: { ...baseTweet, text: '', media: 'photo' } }]);
    expect(out).toBe(`> **@jack** [photo]\n${mirror}`);
  });

  test('multi-line tweet text is flattened', () => {
    const out = renderReply([{
      mirrorUrl: mirror,
      tweet: { ...baseTweet, text: 'line one\nline two\n\nline three' },
    }]);
    expect(out).toBe(`> **@jack**: line one line two line three\n${mirror}`);
  });

  test('long text is truncated with ellipsis', () => {
    const long = 'a'.repeat(400);
    const out = renderReply([{ mirrorUrl: mirror, tweet: { ...baseTweet, text: long } }]);
    const quoteLine = out.split('\n')[0]!;
    expect(quoteLine.length).toBeLessThan(long.length);
    expect(quoteLine.endsWith('…')).toBe(true);
  });

  test('no tweet (fetch failed): just the mirror URL', () => {
    const out = renderReply([{ mirrorUrl: mirror, tweet: null }]);
    expect(out).toBe(mirror);
  });

  test('mixed enriched and mirror-only items separated by blank line', () => {
    const items: ReplyItem[] = [
      { mirrorUrl: 'https://xcancel.com/a/1', tweet: { ...baseTweet, authorScreenName: 'a', text: 'first' } },
      { mirrorUrl: 'https://xcancel.com/b/2', tweet: null },
      { mirrorUrl: 'https://xcancel.com/c/3', tweet: { ...baseTweet, authorScreenName: 'c', text: 'third' } },
    ];
    const out = renderReply(items);
    expect(out).toBe(
      '> **@a**: first\nhttps://xcancel.com/a/1\n\n' +
      'https://xcancel.com/b/2\n\n' +
      '> **@c**: third\nhttps://xcancel.com/c/3',
    );
  });
});
