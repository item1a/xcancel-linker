import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis } from "@devvit/web/server";
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

function isOwnBot(authorName: string | undefined | null): boolean {
  if (!authorName) return false;
  return authorName === context.appName;
}

function tooOld(createdAtMs: number): boolean {
  return Date.now() - createdAtMs > MAX_AGE_MS;
}

async function handleMirrorReply(args: {
  thingId: string;
  scanText: string;
}): Promise<200 | 500> {
  const { thingId, scanText } = args;

  const mirrors = missingMirrors(scanText);
  if (mirrors.length === 0) return 200;

  const dedupKey = `replied:${thingId}`;
  try {
    if (await redis.get(dedupKey)) return 200;
  } catch (err) {
    console.error(
      "[xcancel-linker] redis.get failed, treating as cache miss",
      err,
    );
  }

  try {
    await reddit.submitComment({ id: thingId as `t1_${string}` | `t3_${string}`, text: mirrors.join("\n") });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status && status >= 500) {
      console.error("[xcancel-linker] reddit transient error, will retry", err);
      return 500;
    }
    console.error("[xcancel-linker] reddit permanent error, swallowing", err);
    return 200;
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

  if (isOwnBot(author?.name)) return respond(rsp, 200);
  if (isDeletedOrRemoved(comment?.body)) return respond(rsp, 200);
  if (tooOld(toEpochMs(comment.createdAt))) return respond(rsp, 200);

  const status = await handleMirrorReply({
    thingId: comment.id,
    scanText: comment.body,
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

  if (isOwnBot(author?.name)) return respond(rsp, 200);
  if (isDeletedOrRemoved(post?.selftext)) return respond(rsp, 200);
  if (tooOld(toEpochMs(post.createdAt))) return respond(rsp, 200);

  const scanText = [post.url, post.title, post.selftext]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");

  const status = await handleMirrorReply({
    thingId: post.id,
    scanText,
  });
  respond(rsp, status);
}

function toEpochMs(v: string | number): number {
  if (typeof v === "number") return v;
  return new Date(v).getTime();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export {
  handleMirrorReply,
  isOwnBot,
  tooOld,
  isDeletedOrRemoved,
  respond,
};
