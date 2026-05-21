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
  // Routes are filled in by Tasks 6 (comment-submit) and 7 (post-submit).
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

export {
  handleMirrorReply,
  isOwnBot,
  tooOld,
  isDeletedOrRemoved,
  respond,
};
