import type { IncomingMessage, ServerResponse } from "node:http";
import { reddit, redis } from "@devvit/web/server";
import { missingMirrors } from "./linkFinder.ts";

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEDUP_TTL_S = 7 * 24 * 60 * 60; // 7 days

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    console.error(
      `[xcancel-linker] server error; ${err instanceof Error ? err.stack : err}`,
    );
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

// Bug 4 fix: context.appName returns the app slug (e.g. "xcancel-linker"),
// not the bot's Reddit username. Resolve lazily via reddit.getAppUser() and cache.
let cachedAppUsername: string | null = null;
async function appUsername(): Promise<string | null> {
  if (cachedAppUsername !== null) return cachedAppUsername;
  try {
    const me = await reddit.getAppUser();
    // User type exposes `username` (not `name`) per @devvit/reddit/models/User.d.ts
    cachedAppUsername = me?.username ?? null;
    return cachedAppUsername;
  } catch (err) {
    console.error("[xcancel-linker] could not resolve app user", err);
    return null;
  }
}

async function isOwnBot(authorName: string | undefined | null): Promise<boolean> {
  if (!authorName) return false;
  const me = await appUsername();
  return me !== null && authorName === me;
}

function tooOld(createdAtMs: number): boolean {
  return Date.now() - createdAtMs > MAX_AGE_MS;
}

async function handleMirrorReply(args: {
  thingId: `t1_${string}` | `t3_${string}`;
  mirrors: string[];
}): Promise<200 | 500> {
  const { thingId, mirrors } = args;

  const dedupKey = `replied:${thingId}`;
  try {
    if (await redis.get(dedupKey)) return 200;
  } catch (err) {
    console.error(
      "[xcancel-linker] redis.get failed, treating as cache miss",
      err,
    );
  }

  // Bug 3 fix: Devvit errors come through gRPC machinery and likely don't carry
  // a numeric .status field. Flip the default to retry-on-unknown, swallow-on-4xx.
  try {
    await reddit.submitComment({ id: thingId, text: mirrors.join("\n") });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      console.error("[xcancel-linker] reddit permanent error, swallowing", err);
      return 200;
    }
    console.error("[xcancel-linker] reddit transient error, will retry", err);
    return 500;
  }

  try {
    await redis.set(dedupKey, "1", { expiration: new Date(Date.now() + DEDUP_TTL_S * 1000) });
  } catch (err) {
    console.error(
      "[xcancel-linker] redis.set failed after successful reply",
      err,
    );
  }

  return 200;
}

interface OnCommentSubmitPayload {
  comment: { id: string; body: string; createdAt: string | number };
  author: { name: string };
}

async function handleCommentSubmit(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  let payload: OnCommentSubmitPayload;
  try {
    payload = await readJson<OnCommentSubmitPayload>(req);
  } catch (err) {
    console.error("[xcancel-linker] bad comment payload", err);
    respond(rsp, 200);
    return;
  }

  const { comment, author } = payload;

  if (isDeletedOrRemoved(comment?.body)) return respond(rsp, 200);
  if (tooOld(toEpochMs(comment.createdAt))) return respond(rsp, 200);

  const mirrors = missingMirrors(comment.body);
  if (mirrors.length === 0) return respond(rsp, 200);

  if (await isOwnBot(author?.name)) return respond(rsp, 200);

  // Trigger payload's comment.id arrives already prefixed (e.g. "t1_abc"),
  // confirmed by smoke test against the live trigger wire format. The .d.ts
  // type `string` does not encode this. Guard against double-prefixing.
  const rawId = comment.id;
  const thingId = rawId.startsWith("t1_")
    ? (rawId as `t1_${string}`)
    : (`t1_${rawId}` as const);

  const status = await handleMirrorReply({ thingId, mirrors });
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
  author: { name: string };
}

async function handlePostSubmit(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  let payload: OnPostSubmitPayload;
  try {
    payload = await readJson<OnPostSubmitPayload>(req);
  } catch (err) {
    console.error("[xcancel-linker] bad post payload", err);
    respond(rsp, 200);
    return;
  }

  const { post, author } = payload;

  if (isDeletedOrRemoved(post?.selftext)) return respond(rsp, 200);
  if (tooOld(toEpochMs(post.createdAt))) return respond(rsp, 200);

  const scanText = [post.url, post.title, post.selftext]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");

  const mirrors = missingMirrors(scanText);
  if (mirrors.length === 0) return respond(rsp, 200);

  if (await isOwnBot(author?.name)) return respond(rsp, 200);

  const rawId = post.id;
  const thingId = rawId.startsWith("t3_")
    ? (rawId as `t3_${string}`)
    : (`t3_${rawId}` as const);

  const status = await handleMirrorReply({ thingId, mirrors });
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
