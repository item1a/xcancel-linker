import type { IncomingMessage, ServerResponse } from "node:http";
import { reddit, redis } from "@devvit/web/server";
import { missingMirrors, tweetId } from "./linkFinder.ts";
import { fetchTweet } from "./fxtwitter.ts";
import { renderReply, type ReplyItem } from "./render.ts";
import { log, serializeErr } from "./log.ts";

const XCANCEL_PREFIX = "https://xcancel.com/";

// Fetch tweet metadata for each mirror in parallel; fail-open per item so a
// single fetch error doesn't degrade the rest of the reply.
async function buildReplyItems(mirrorUrls: string[]): Promise<ReplyItem[]> {
  return Promise.all(
    mirrorUrls.map(async (mirrorUrl) => {
      const path = mirrorUrl.startsWith(XCANCEL_PREFIX)
        ? mirrorUrl.slice(XCANCEL_PREFIX.length)
        : "";
      const id = tweetId(path);
      if (!id) return { mirrorUrl, tweet: null };
      return { mirrorUrl, tweet: await fetchTweet(id) };
    }),
  );
}

// Self-recursion note: we intentionally don't check author == app bot. Our
// reply contains only xcancel.com URLs (HOST_RE doesn't match those), so
// missingMirrors() returns [] for our own replies and we bail before any
// reddit call. The mirror-already-present check provides a second structural
// guard if the reply format ever grows to include the original x.com URL too.

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEDUP_TTL_S = 7 * 24 * 60 * 60; // 7 days
// Cap the per-reply mirror count so a link-heavy post can't make us produce a
// wall-of-URLs comment. First N is fine in practice; remaining links rarely
// matter and would just degrade the signal-to-noise ratio of our reply.
const MAX_MIRRORS_PER_REPLY = 5;

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    log("error", "server_uncaught", { url: req.url, ...serializeErr(err) });
    respond(rsp, 500);
  }
}

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  if (req.method === "POST" && req.url === "/internal/on-comment-submit") {
    return handleCommentSubmit(req, rsp);
  }
  if (req.method === "POST" && req.url === "/internal/on-post-submit") {
    return handlePostSubmit(req, rsp);
  }
  respond(rsp, 404);
}

function respond(rsp: ServerResponse, status: number): void {
  rsp.writeHead(status);
  rsp.end();
}

function isDeletedOrRemoved(body: string | undefined | null): boolean {
  return body === "[deleted]" || body === "[removed]";
}

function tooOld(createdAtMs: number): boolean {
  return Date.now() - createdAtMs > MAX_AGE_MS;
}

async function handleMirrorReply(args: {
  thingId: `t1_${string}` | `t3_${string}`;
  replyText: string;
  enriched: number;
  total: number;
}): Promise<200 | 500> {
  const { thingId, replyText, enriched, total } = args;

  const dedupKey = `replied:${thingId}`;

  // Atomically claim the dedup slot BEFORE replying. Read-then-write let two
  // concurrent triggers (or retries) both pass the check and post duplicates;
  // SET NX collapses that to a single winner.
  let claimed: string | null | undefined;
  try {
    claimed = await redis.set(dedupKey, "1", {
      nx: true,
      expiration: new Date(Date.now() + DEDUP_TTL_S * 1000),
    });
  } catch (err) {
    log("warn", "redis_set_nx_failed", { thing_id: thingId, ...serializeErr(err) });
    return 500;
  }
  // Redis returns nil (→ empty/undefined here) when NX is set and the key
  // already exists. Treat any falsy/empty return as "another worker has it."
  if (!claimed) {
    log("info", "dedup_hit", { thing_id: thingId });
    return 200;
  }

  // @devvit/reddit's Comment.submit collapses ALL Reddit application-level
  // errors (RATELIMIT, DELETED_COMMENT, TOO_OLD, SUBREDDIT_NOTALLOWED, …) into
  // a single Error('failed to reply to comment') with no .status or .code, so
  // we can't distinguish permanent from transient from this side. Treat every
  // failure as transient: in every case where Reddit fills its errors array
  // the comment was NOT posted, so retrying can't create a duplicate via this
  // path. The 1-hour tooOld filter bounds wasted retries on truly permanent
  // failures (locked thread, banned sub).
  try {
    await reddit.submitComment({ id: thingId, text: replyText });
  } catch (err) {
    try {
      await redis.del(dedupKey);
    } catch (delErr) {
      log("error", "redis_del_rollback_failed", { thing_id: thingId, ...serializeErr(delErr) });
    }
    log("warn", "reply_retrying_transient", { thing_id: thingId, ...serializeErr(err) });
    return 500;
  }

  log("info", "reply_posted", {
    thing_id: thingId,
    n_mirrors: total,
    n_enriched: enriched,
  });
  return 200;
}

interface OnCommentSubmitPayload {
  comment: { id: string; body: string; createdAt: string | number };
}

async function handleCommentSubmit(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  let payload: OnCommentSubmitPayload;
  try {
    payload = await readJson<OnCommentSubmitPayload>(req);
  } catch (err) {
    log("error", "bad_payload", { kind: "comment", ...serializeErr(err) });
    respond(rsp, 200);
    return;
  }

  const { comment } = payload;

  if (isDeletedOrRemoved(comment?.body)) return respond(rsp, 200);
  if (tooOld(toEpochMs(comment.createdAt))) return respond(rsp, 200);

  const mirrors = missingMirrors(comment.body).slice(0, MAX_MIRRORS_PER_REPLY);
  if (mirrors.length === 0) return respond(rsp, 200);

  const items = await buildReplyItems(mirrors);
  const replyText = renderReply(items);
  const enriched = items.filter((it) => it.tweet !== null).length;

  // Trigger payload's comment.id arrives already prefixed (e.g. "t1_abc"),
  // confirmed by smoke test against the live trigger wire format. The .d.ts
  // type `string` does not encode this. Guard against double-prefixing.
  const rawId = comment.id;
  const thingId = rawId.startsWith("t1_")
    ? (rawId as `t1_${string}`)
    : (`t1_${rawId}` as const);

  const status = await handleMirrorReply({
    thingId,
    replyText,
    enriched,
    total: items.length,
  });
  respond(rsp, status);
}

interface OnPostSubmitPayload {
  post: {
    id: string;
    title: string;
    url?: string | null;
    selftext?: string | null;
    createdAt: string | number;
  };
}

async function handlePostSubmit(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  let payload: OnPostSubmitPayload;
  try {
    payload = await readJson<OnPostSubmitPayload>(req);
  } catch (err) {
    log("error", "bad_payload", { kind: "post", ...serializeErr(err) });
    respond(rsp, 200);
    return;
  }

  const { post } = payload;

  if (isDeletedOrRemoved(post?.selftext)) return respond(rsp, 200);
  if (tooOld(toEpochMs(post.createdAt))) return respond(rsp, 200);

  const scanText = [post.url, post.title, post.selftext]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");

  const mirrors = missingMirrors(scanText).slice(0, MAX_MIRRORS_PER_REPLY);
  if (mirrors.length === 0) return respond(rsp, 200);

  const items = await buildReplyItems(mirrors);
  const replyText = renderReply(items);
  const enriched = items.filter((it) => it.tweet !== null).length;

  const rawId = post.id;
  const thingId = rawId.startsWith("t3_")
    ? (rawId as `t3_${string}`)
    : (`t3_${rawId}` as const);

  const status = await handleMirrorReply({
    thingId,
    replyText,
    enriched,
    total: items.length,
  });
  respond(rsp, status);
}

// Trigger payload's createdAt arrives as a number in milliseconds (e.g.
// 1779343721732 ≈ May 2026), confirmed by smoke test. ISO-string fallback
// kept defensively in case a future Devvit version serializes it differently.
function toEpochMs(v: string | number): number {
  if (typeof v === "number") return v;
  return new Date(v).getTime();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
