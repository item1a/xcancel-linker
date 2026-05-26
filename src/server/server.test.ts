import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';

const submitComment = vi.fn();
const getAppUser = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock('@devvit/web/server', () => ({
  reddit: {
    submitComment: (...a: unknown[]) => submitComment(...a),
    getAppUser: (...a: unknown[]) => getAppUser(...a),
  },
  redis: {
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
  },
}));

const { serverOnRequest } = await import('./server.ts');

const BOT = 'xcancel-linker-bot';

interface MockRsp {
  writeHead: (s: number) => void;
  end: () => void;
  status: number | null;
  ended: boolean;
}

function makeReq(url: string, body: unknown): {
  method: string;
  url: string;
  [Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
} {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  // serverOnRequest only touches method, url, and async iteration.
  return Object.assign(stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> }, {
    method: 'POST',
    url,
  });
}

function makeRsp(): MockRsp {
  const rsp: MockRsp = {
    status: null,
    ended: false,
    writeHead(s: number) {
      rsp.status = s;
    },
    end() {
      rsp.ended = true;
    },
  };
  return rsp;
}

async function postComment(body: Record<string, unknown>): Promise<MockRsp> {
  const req = makeReq('/internal/on-comment-submit', body);
  const rsp = makeRsp();
  // serverOnRequest signature accepts node types we don't fully implement; the
  // mocks satisfy the runtime contract (method/url/iteration; writeHead/end).
  await serverOnRequest(req as never, rsp as never);
  return rsp;
}

async function postPost(body: Record<string, unknown>): Promise<MockRsp> {
  const req = makeReq('/internal/on-post-submit', body);
  const rsp = makeRsp();
  await serverOnRequest(req as never, rsp as never);
  return rsp;
}

function freshComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment: {
      id: 't1_abc',
      body: 'check https://x.com/foo/status/1',
      createdAt: Date.now(),
      ...((overrides.comment as object) ?? {}),
    },
    author: { name: 'someone-else', ...((overrides.author as object) ?? {}) },
  };
}

beforeEach(() => {
  submitComment.mockReset();
  getAppUser.mockReset();
  redisSet.mockReset();
  redisDel.mockReset();
  getAppUser.mockResolvedValue({ username: BOT });
  redisSet.mockResolvedValue('OK');
  submitComment.mockResolvedValue(undefined);
  // Tests emit JSON log lines on info/warn/error; suppress for readable output.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('routing', () => {
  test('unknown path returns 404', async () => {
    const req = makeReq('/internal/nope', {});
    const rsp = makeRsp();
    await serverOnRequest(req as never, rsp as never);
    expect(rsp.status).toBe(404);
    expect(rsp.ended).toBe(true);
  });

  test('malformed JSON returns 200 and does not call reddit/redis', async () => {
    const stream = Readable.from([Buffer.from('{not json')]);
    const req = Object.assign(
      stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> },
      { method: 'POST', url: '/internal/on-comment-submit' },
    );
    const rsp = makeRsp();
    await serverOnRequest(req as never, rsp as never);
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('comment handler short-circuits', () => {
  test('deleted body → 200, no reddit/redis', async () => {
    const rsp = await postComment(freshComment({ comment: { id: 't1_x', body: '[deleted]', createdAt: Date.now() } }));
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  test('removed body → 200, no reddit/redis', async () => {
    const rsp = await postComment(freshComment({ comment: { id: 't1_x', body: '[removed]', createdAt: Date.now() } }));
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
  });

  test('too old → 200, no reddit/redis', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const rsp = await postComment(freshComment({ comment: { id: 't1_x', body: 'https://x.com/a/1', createdAt: twoHoursAgo } }));
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  test('no twitter links → 200, no getAppUser/redis call', async () => {
    const rsp = await postComment(freshComment({ comment: { id: 't1_x', body: 'no links here', createdAt: Date.now() } }));
    expect(rsp.status).toBe(200);
    expect(getAppUser).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(submitComment).not.toHaveBeenCalled();
  });

  test('own bot author with links → 200, no submit', async () => {
    const rsp = await postComment(freshComment({ author: { name: BOT } }));
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('handleMirrorReply (via comment handler)', () => {
  test('happy path: SET NX called, submitComment called with mirrors', async () => {
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(200);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisSet.mock.calls[0]?.[0]).toBe('replied:t1_abc');
    expect(redisSet.mock.calls[0]?.[2]).toMatchObject({ nx: true });
    expect(submitComment).toHaveBeenCalledWith({
      id: 't1_abc',
      text: 'https://xcancel.com/foo/status/1',
    });
    expect(redisDel).not.toHaveBeenCalled();
  });

  test('dedup hit: SET NX returns empty → 200, no submit', async () => {
    redisSet.mockResolvedValueOnce('');
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
  });

  test('dedup hit via undefined: SET NX returns undefined → 200, no submit', async () => {
    redisSet.mockResolvedValueOnce(undefined);
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(200);
    expect(submitComment).not.toHaveBeenCalled();
  });

  test('reddit error (generic) → 500, claim released via del', async () => {
    // Matches the actual shape of @devvit/reddit's submit-comment failure:
    // generic Error with no .status or .code.
    submitComment.mockRejectedValueOnce(new Error('failed to reply to comment'));
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(500);
    expect(redisDel).toHaveBeenCalledWith('replied:t1_abc');
  });

  test('reddit error with status field still treated as transient', async () => {
    // Defensive: if a future Devvit version starts attaching a status, we
    // shouldn't suddenly start swallowing replies as "permanent."
    submitComment.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }));
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(500);
    expect(redisDel).toHaveBeenCalledWith('replied:t1_abc');
  });

  test('redis SET failure → 500, no submit attempted', async () => {
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    const rsp = await postComment(freshComment());
    expect(rsp.status).toBe(500);
    expect(submitComment).not.toHaveBeenCalled();
  });
});

describe('ID prefixing', () => {
  test('comment id without t1_ prefix gets prefixed', async () => {
    await postComment(freshComment({ comment: { id: 'abc', body: 'https://x.com/foo/status/1', createdAt: Date.now() } }));
    expect(redisSet.mock.calls[0]?.[0]).toBe('replied:t1_abc');
    expect(submitComment.mock.calls[0]?.[0]).toMatchObject({ id: 't1_abc' });
  });

  test('comment id with t1_ prefix is not double-prefixed', async () => {
    await postComment(freshComment({ comment: { id: 't1_xyz', body: 'https://x.com/foo/status/1', createdAt: Date.now() } }));
    expect(redisSet.mock.calls[0]?.[0]).toBe('replied:t1_xyz');
  });

  test('post id without t3_ prefix gets prefixed', async () => {
    await postPost({
      post: { id: 'pid', title: 't', url: 'https://x.com/foo/status/1', selftext: '', createdAt: Date.now() },
      author: { name: 'someone' },
    });
    expect(redisSet.mock.calls[0]?.[0]).toBe('replied:t3_pid');
    expect(submitComment.mock.calls[0]?.[0]).toMatchObject({ id: 't3_pid' });
  });

  test('post id with t3_ prefix is not double-prefixed', async () => {
    await postPost({
      post: { id: 't3_pid', title: 't', url: 'https://x.com/foo/status/1', selftext: '', createdAt: Date.now() },
      author: { name: 'someone' },
    });
    expect(redisSet.mock.calls[0]?.[0]).toBe('replied:t3_pid');
  });
});

describe('post handler', () => {
  test('scans url, title, and selftext together', async () => {
    await postPost({
      post: {
        id: 't3_p',
        title: 'title with https://x.com/a/1',
        url: 'https://x.com/b/2',
        selftext: 'body https://x.com/c/3',
        createdAt: Date.now(),
      },
      author: { name: 'op' },
    });
    expect(submitComment).toHaveBeenCalledTimes(1);
    const text = submitComment.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain('https://xcancel.com/a/1');
    expect(text).toContain('https://xcancel.com/b/2');
    expect(text).toContain('https://xcancel.com/c/3');
  });

  test('caps reply at 5 mirrors', async () => {
    const links = Array.from({ length: 8 }, (_, i) => `https://x.com/u/${i}`).join(' ');
    await postPost({
      post: { id: 't3_p', title: 't', url: '', selftext: links, createdAt: Date.now() },
      author: { name: 'op' },
    });
    const text = submitComment.mock.calls[0]?.[0]?.text as string;
    expect(text.split('\n')).toHaveLength(5);
  });
});
