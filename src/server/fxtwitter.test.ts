import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const redisGet = vi.fn();
const redisSet = vi.fn();

vi.mock('@devvit/web/server', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
  },
}));

const { fetchTweet } = await import('./fxtwitter.ts');

const originalFetch = globalThis.fetch;

function makeFetchRsp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  redisGet.mockReset();
  redisSet.mockReset();
  redisGet.mockResolvedValue(undefined);
  redisSet.mockResolvedValue('OK');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>): typeof fetch {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as typeof fetch;
}

describe('fetchTweet — happy paths', () => {
  test('parses a standard photo tweet', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: {
          type: 'status',
          text: 'hello world',
          possibly_sensitive: false,
          author: { screen_name: 'jack' },
          media: { all: [{ type: 'photo' }] },
        },
      }),
    );
    const t = await fetchTweet('1');
    expect(t).toEqual({
      id: '1',
      authorScreenName: 'jack',
      text: 'hello world',
      sensitive: false,
      media: 'photo',
    });
  });

  test('tweet with no media → media: "none"', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: { type: 'status', text: 't', author: { screen_name: 'u' } },
      }),
    );
    const t = await fetchTweet('2');
    expect(t?.media).toBe('none');
  });

  test('sensitive flag propagates', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: {
          type: 'status',
          text: 'nsfw',
          possibly_sensitive: true,
          author: { screen_name: 'u' },
        },
      }),
    );
    const t = await fetchTweet('3');
    expect(t?.sensitive).toBe(true);
  });

  test('writes successful fetches to cache', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: { type: 'status', text: 't', author: { screen_name: 'u' } },
      }),
    );
    await fetchTweet('4');
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisSet.mock.calls[0]?.[0]).toBe('tweet:4');
  });
});

describe('fetchTweet — fail-open paths', () => {
  test('returns null and does not cache on 404', async () => {
    stubFetch(async () => makeFetchRsp(404, { code: 404 }));
    expect(await fetchTweet('5')).toBeNull();
    expect(redisSet).not.toHaveBeenCalled();
  });

  test('returns null on 401 (private)', async () => {
    stubFetch(async () => makeFetchRsp(401, { code: 401 }));
    expect(await fetchTweet('6')).toBeNull();
  });

  test('returns null on 500 (upstream)', async () => {
    stubFetch(async () => makeFetchRsp(500, { code: 500 }));
    expect(await fetchTweet('7')).toBeNull();
  });

  test('returns null on tombstone (deleted)', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: { type: 'tombstone' },
      }),
    );
    expect(await fetchTweet('8')).toBeNull();
    expect(redisSet).not.toHaveBeenCalled();
  });

  test('returns null on network error', async () => {
    stubFetch(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await fetchTweet('9')).toBeNull();
  });

  test('returns null on JSON parse failure', async () => {
    stubFetch(async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await fetchTweet('10')).toBeNull();
  });

  test('returns null when status missing required fields', async () => {
    stubFetch(async () =>
      makeFetchRsp(200, { code: 200, status: { type: 'status', text: 't' } }),
    );
    expect(await fetchTweet('11')).toBeNull();
  });
});

describe('fetchTweet — cache', () => {
  test('cache hit short-circuits the network', async () => {
    redisGet.mockResolvedValueOnce(JSON.stringify({
      id: '12',
      authorScreenName: 'cached',
      text: 'from cache',
      sensitive: false,
      media: 'none',
    }));
    const f = stubFetch(async () => makeFetchRsp(200, { code: 200, status: null }));
    const t = await fetchTweet('12');
    expect(t?.text).toBe('from cache');
    expect(f).not.toHaveBeenCalled();
  });

  test('cache read failure falls through to network', async () => {
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    stubFetch(async () =>
      makeFetchRsp(200, {
        code: 200,
        status: { type: 'status', text: 't', author: { screen_name: 'u' } },
      }),
    );
    const t = await fetchTweet('13');
    expect(t?.authorScreenName).toBe('u');
  });
});

describe('fetchTweet — abort', () => {
  test('AbortError from fetch maps to null', async () => {
    // Real-world shape: the AbortController timeout fires, fetch's signal
    // aborts, and fetch rejects with an AbortError. We verify the resulting
    // error is handled the same as any other network failure.
    stubFetch(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await fetchTweet('14')).toBeNull();
  });

  test('fetch is given an AbortSignal so the timeout can cancel it', async () => {
    let receivedSignal: AbortSignal | null = null;
    stubFetch(async (_input, init) => {
      receivedSignal = (init?.signal ?? null) as AbortSignal | null;
      return makeFetchRsp(200, { code: 200, status: { type: 'status', text: 't', author: { screen_name: 'u' } } });
    });
    await fetchTweet('15');
    expect(receivedSignal).not.toBeNull();
  });
});
