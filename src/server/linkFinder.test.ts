import { describe, expect, test } from 'vitest';
import { extractTwitterUrls } from './linkFinder.ts';

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
});
