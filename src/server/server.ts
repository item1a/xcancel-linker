import type { IncomingMessage, ServerResponse } from "node:http";
import { reddit, redis } from "@devvit/web/server";
import { findMirrors, type MirrorMatch } from "./linkFinder.ts";
import { fetchTweet } from "./fxtwitter.ts";
import { renderReply, type ReplyItem } from "./render.ts";
import { log, serializeErr } from "./log.ts";

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEDUP_TTL_S = 7 * 24 * 60 * 60; // 7 days
// Cap the per-reply mirror count so a link-heavy post can't make us produce a
// wall-of-URLs comment. First N is fine in practice; remaining links rarely
// matter and would just degrade the signal-to-noise ratio of our reply.
const MAX_MIRRORS_PER_REPLY = 5;

// Self-recursion is prevented structurally, not via an isOwnBot check: our
// reply contains only xcancel.com URLs, which the HOST_RE in linkFinder
// doesn't match, so findMirrors returns no items for our own replies and we
// bail before any reddit call. The "mirror already present" check is a
// second guard if the reply format ever grows to include the original URL.

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

// Trigger payload's createdAt arrives as a number in milliseconds, confirmed
// by smoke test. ISO-string fallback kept in case a future Devvit version
// serializes it differently.
function toEpochMs(v: string | number): number {
  return typeof v === "number" ? v : new Date(v).getTime();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Fetch tweet metadata for each mirror in parallel; fail-open per item so a
// single fetch error doesn't degrade the rest of the reply.
async function buildReplyItems(matches: MirrorMatch[]): Promise<ReplyItem[]> {
  return Promise.all(
    matches.map(async ({ mirrorUrl, tweetId }) => ({
      mirrorUrl,
      tweet: tweetId ? await fetchTweet(tweetId) : null,
    })),
  );
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
  // concurrent triggers (or retries) both pass the check and post duplicates.
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
  // Falsy return = key already existed (NX miss). Another worker has it.
  if (!claimed) {
    log("info", "dedup_hit", { thing_id: thingId });
    return 200;
  }

  // @devvit/reddit collapses every Reddit application-level error (RATELIMIT,
  // DELETED_COMMENT, …) into a generic Error with no .status/.code, so we
  // can't tell permanent from transient. Treat all as transient: in every
  // error case the comment was NOT posted, so retry can't duplicate. The
  // 1-hour tooOld filter bounds wasted retries on truly permanent failures.
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

  log("info", "reply_posted", { thing_id: thingId, n_mirrors: total, n_enriched: enriched });
  return 200;
}

// Common shape extracted from either trigger payload before the pipeline runs.
interface NormalizedTrigger {
  rawId: string;
  createdAt: string | number;
  // Body to check for "[deleted]"/"[removed]" — comment body or post selftext.
  checkBody: string | null | undefined;
  // Text to scan for twitter URLs.
  scanText: string;
}

// Shared trigger pipeline. The only thing that differs between
// onCommentSubmit and onPostSubmit is how the payload maps into the four
// NormalizedTrigger fields plus the `t1_`/`t3_` thing-id prefix.
async function handleSubmitTrigger(
  req: IncomingMessage,
  rsp: ServerResponse,
  kind: "comment" | "post",
  prefix: "t1_" | "t3_",
  normalize: (payload: unknown) => NormalizedTrigger,
): Promise<void> {
  let trigger: NormalizedTrigger;
  try {
    trigger = normalize(await readJson<unknown>(req));
  } catch (err) {
    log("error", "bad_payload", { kind, ...serializeErr(err) });
    respond(rsp, 200);
    return;
  }

  const { rawId, createdAt, checkBody, scanText } = trigger;

  if (isDeletedOrRemoved(checkBody)) return respond(rsp, 200);
  if (tooOld(toEpochMs(createdAt))) return respond(rsp, 200);

  const { items: allMatches, rawCount } = findMirrors(scanText);
  const matches = allMatches.slice(0, MAX_MIRRORS_PER_REPLY);
  if (matches.length === 0) return respond(rsp, 200);

  if (rawCount !== matches.length) {
    // Healthy: rawCount > matches.length when dedup collapsed duplicates.
    // Surfaces a regression silently if dedup ever stops collapsing them.
    log("debug", "extraction_stats", {
      thing_id: rawId,
      raw_matches: rawCount,
      deduped_mirrors: matches.length,
    });
  }

  const items = await buildReplyItems(matches);
  const replyText = renderReply(items);
  const enriched = items.filter((it) => it.tweet !== null).length;

  // Trigger payload's id arrives already prefixed (e.g. "t1_abc"), confirmed
  // by smoke test. The .d.ts type `string` doesn't encode this, so guard
  // against double-prefixing.
  const thingId = (rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`) as
    | `t1_${string}`
    | `t3_${string}`;

  const status = await handleMirrorReply({
    thingId,
    replyText,
    enriched,
    total: items.length,
  });
  respond(rsp, status);
}

interface OnCommentSubmitPayload {
  comment: { id: string; body: string; createdAt: string | number };
}

function handleCommentSubmit(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  return handleSubmitTrigger(req, rsp, "comment", "t1_", (raw) => {
    const { comment } = raw as OnCommentSubmitPayload;
    return {
      rawId: comment.id,
      createdAt: comment.createdAt,
      checkBody: comment.body,
      scanText: comment.body,
    };
  });
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

function handlePostSubmit(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  return handleSubmitTrigger(req, rsp, "post", "t3_", (raw) => {
    const { post } = raw as OnPostSubmitPayload;
    const scanText = [post.url, post.title, post.selftext]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n");
    return {
      rawId: post.id,
      createdAt: post.createdAt,
      checkBody: post.selftext,
      scanText,
    };
  });
}

async function onRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  if (req.method === "POST" && req.url === "/internal/on-comment-submit") {
    return handleCommentSubmit(req, rsp);
  }
  if (req.method === "POST" && req.url === "/internal/on-post-submit") {
    return handlePostSubmit(req, rsp);
  }
  respond(rsp, 404);
}

export async function serverOnRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    log("error", "server_uncaught", { url: req.url, ...serializeErr(err) });
    respond(rsp, 500);
  }
}
