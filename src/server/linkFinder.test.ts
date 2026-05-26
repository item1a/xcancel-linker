import { describe, expect, test } from 'vitest';
import { extractTwitterUrls, missingMirrors, tweetId } from './linkFinder.ts';

describe('extractTwitterUrls', () => {
  test('single x.com link', () => {
    expect(extractTwitterUrls('check this https://x.com/foo/status/1 out')).toEqual([
      { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
    ]);
  });

  test('twitter.com link', () => {
    expect(extractTwitterUrls('https://twitter.com/foo/status/1')).toEqual([
      { url: 'https://twitter.com/foo/status/1', path: 'foo/status/1' },
    ]);
  });

  test('mobile.twitter.com link', () => {
    expect(extractTwitterUrls('https://mobile.twitter.com/foo/status/1')).toEqual([
      { url: 'https://mobile.twitter.com/foo/status/1', path: 'foo/status/1' },
    ]);
  });

  test('http (not https) is matched', () => {
    expect(extractTwitterUrls('http://x.com/foo')).toEqual([
      { url: 'http://x.com/foo', path: 'foo' },
    ]);
  });

  test('multiple links in order', () => {
    const r = extractTwitterUrls('a https://x.com/a/1 and b https://twitter.com/b/2 end');
    expect(r).toEqual([
      { url: 'https://x.com/a/1', path: 'a/1' },
      { url: 'https://twitter.com/b/2', path: 'b/2' },
    ]);
  });

  test('bare host with no path is ignored', () => {
    expect(extractTwitterUrls('https://x.com is the new twitter')).toEqual([]);
    expect(extractTwitterUrls('https://x.com/ is also bare')).toEqual([]);
  });

  test('preserves query strings', () => {
    expect(extractTwitterUrls('https://x.com/foo/status/1?s=20&t=abc')).toEqual([
      { url: 'https://x.com/foo/status/1?s=20&t=abc', path: 'foo/status/1?s=20&t=abc' },
    ]);
  });

  test('strips trailing sentence punctuation', () => {
    expect(extractTwitterUrls('see https://x.com/foo/status/1.')).toEqual([
      { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
    ]);
    expect(extractTwitterUrls('(https://x.com/foo/status/1)')).toEqual([
      { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
    ]);
    expect(extractTwitterUrls('[https://x.com/foo/status/1]')).toEqual([
      { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
    ]);
    for (const punct of ['!', '?', ';', ':']) {
      expect(extractTwitterUrls(`wow https://x.com/foo/status/1${punct}`)).toEqual([
        { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
      ]);
    }
  });

  test('markdown link syntax', () => {
    expect(extractTwitterUrls('see [the post](https://x.com/foo/status/1) please')).toEqual([
      { url: 'https://x.com/foo/status/1', path: 'foo/status/1' },
    ]);
  });

  test('no twitter links', () => {
    expect(extractTwitterUrls('hello world https://github.com/foo')).toEqual([]);
  });

  test('does not match unrelated subdomains', () => {
    expect(extractTwitterUrls('https://api.twitter.com/foo')).toEqual([]);
    expect(extractTwitterUrls('https://docs.x.com/foo')).toEqual([]);
  });

  test('strips Reddit markdown backslash escapes', () => {
    // Reddit stores 'AST_SpaceMobile' as 'AST\_SpaceMobile' in raw selftext
    // to prevent italicization. The captured path must match the unescaped form.
    expect(extractTwitterUrls('https://x.com/AST\\_SpaceMobile')).toEqual([
      { url: 'https://x.com/AST_SpaceMobile', path: 'AST_SpaceMobile' },
    ]);
    expect(extractTwitterUrls('https://x.com/AST\\_SpaceMobile/status/123')).toEqual([
      { url: 'https://x.com/AST_SpaceMobile/status/123', path: 'AST_SpaceMobile/status/123' },
    ]);
  });
});

describe('missingMirrors', () => {
  test('single link → one mirror', () => {
    expect(missingMirrors('see https://x.com/foo/status/1')).toEqual([
      'https://xcancel.com/foo/status/1',
    ]);
  });

  test('multiple links → multiple mirrors, in order', () => {
    expect(missingMirrors('a https://x.com/a/1 b https://twitter.com/b/2')).toEqual([
      'https://xcancel.com/a/1',
      'https://xcancel.com/b/2',
    ]);
  });

  test('duplicates collapsed', () => {
    expect(missingMirrors('https://x.com/a/1 again https://x.com/a/1')).toEqual([
      'https://xcancel.com/a/1',
    ]);
  });

  test('mirror already present is excluded', () => {
    const text = 'orig https://x.com/a/1 mirror https://xcancel.com/a/1';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('partial-mirror-present case: only the un-mirrored ones returned', () => {
    const text = [
      'orig1 https://x.com/a/1',
      'orig2 https://x.com/b/2',
      'mirror1 https://xcancel.com/a/1',
    ].join('\n');
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/b/2']);
  });

  test('no twitter links → empty', () => {
    expect(missingMirrors('hello world')).toEqual([]);
  });

  test('strips X tracking query string from mirror', () => {
    expect(missingMirrors('https://x.com/foo/status/1?s=20')).toEqual([
      'https://xcancel.com/foo/status/1',
    ]);
  });

  test('strips fragment from mirror', () => {
    expect(missingMirrors('https://x.com/foo/status/1#anchor')).toEqual([
      'https://xcancel.com/foo/status/1',
    ]);
  });

  test('strips trailing slash from mirror', () => {
    expect(missingMirrors('https://x.com/foo/status/1/')).toEqual([
      'https://xcancel.com/foo/status/1',
    ]);
  });

  test('dedupes URLs differing only in tracking params', () => {
    const text = 'https://x.com/foo/status/1?s=20&t=abc https://x.com/foo/status/1?s=46';
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/foo/status/1']);
  });

  test('dedupes URLs differing only in trailing slash', () => {
    const text = 'https://x.com/foo/status/1 https://x.com/foo/status/1/';
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/foo/status/1']);
  });

  test('dedupes profile URL appearing with and without trackers', () => {
    const text = 'https://x.com/AST_SpaceMobile?s=46 https://x.com/AST_SpaceMobile';
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/AST_SpaceMobile']);
  });

  test('dedupes escaped vs unescaped underscore variants', () => {
    // The exact real-world bug: post.url has the raw form while post.selftext
    // has the Reddit-markdown-escaped form. Both should collapse to one mirror.
    const text = 'https://x.com/AST_SpaceMobile\nhttps://x.com/AST\\_SpaceMobile';
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/AST_SpaceMobile']);
  });

  test('dedupes the exact failing case: profile + status, escaped + unescaped', () => {
    const text = [
      'https://x.com/AST\\_SpaceMobile',
      'https://x.com/AST_SpaceMobile',
      'https://x.com/AST\\_SpaceMobile/status/2057846652870840333',
      'https://x.com/AST_SpaceMobile/status/2057846652870840333',
    ].join('\n');
    expect(missingMirrors(text)).toEqual([
      'https://xcancel.com/AST_SpaceMobile',
      'https://xcancel.com/AST_SpaceMobile/status/2057846652870840333',
    ]);
  });

  test('case-insensitive mirror-already-present detection', () => {
    const text = 'orig https://x.com/foo/status/1 mirror HTTPS://Xcancel.com/foo/status/1';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('trailing slash on existing mirror still counts as present', () => {
    const text = 'orig https://x.com/foo/status/1 mirror https://xcancel.com/foo/status/1/';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('duplicate twitter links differing only in case yield one mirror', () => {
    expect(missingMirrors('https://x.com/Foo/status/1 https://x.com/foo/status/1')).toEqual([
      'https://xcancel.com/Foo/status/1',
    ]);
  });

  test('fxtwitter mirror to same tweet suppresses our mirror', () => {
    const text = 'orig https://x.com/foo/status/1 fxd https://fxtwitter.com/foo/status/1';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('vxtwitter / fixupx / fixvx are also recognized', () => {
    for (const host of ['vxtwitter.com', 'fixupx.com', 'fixvx.com']) {
      expect(missingMirrors(`https://x.com/foo/status/1 https://${host}/foo/status/1`)).toEqual([]);
    }
  });

  test('fixer with different query string still counts as same tweet', () => {
    const text = 'https://x.com/foo/status/1?s=20 https://fxtwitter.com/foo/status/1';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('fixer with trailing slash still counts as same tweet', () => {
    const text = 'https://x.com/foo/status/1 https://fxtwitter.com/foo/status/1/';
    expect(missingMirrors(text)).toEqual([]);
  });

  test('fixer for a different tweet does not suppress', () => {
    const text = 'https://x.com/foo/status/1 https://fxtwitter.com/bar/status/2';
    expect(missingMirrors(text)).toEqual(['https://xcancel.com/foo/status/1']);
  });
});

describe('tweetId', () => {
  test('extracts numeric id from status path', () => {
    expect(tweetId('user/status/1234567890')).toBe('1234567890');
  });

  test('ignores query string', () => {
    expect(tweetId('user/status/1234?s=20&t=abc')).toBe('1234');
  });

  test('ignores trailing photo segment', () => {
    expect(tweetId('user/status/1234/photo/1')).toBe('1234');
  });

  test('ignores trailing slash', () => {
    expect(tweetId('user/status/1234/')).toBe('1234');
  });

  test('returns null for non-status path', () => {
    expect(tweetId('user')).toBeNull();
    expect(tweetId('user/likes')).toBeNull();
    expect(tweetId('hashtag/foo')).toBeNull();
  });

  test('returns null for non-numeric id', () => {
    expect(tweetId('user/status/abc')).toBeNull();
  });
});
