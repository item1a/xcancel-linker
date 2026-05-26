import { redis } from "@devvit/web/server";
import { log, serializeErr } from "./log.ts";

// Subset of the fxtwitter /2/status/{id} response we actually use. The full
// schema is much larger (engagement counts, embed cards, articles, etc.) —
// kept narrow so we don't promise consumers fields that might disappear if
// the upstream schema shifts.
export interface Tweet {
  id: string;
  authorScreenName: string;
  text: string;
  sensitive: boolean;
  media: "photo" | "video" | "gif" | "none";
}

interface FxResponse {
  code: number;
  status?: {
    type?: string;
    text?: string;
    possibly_sensitive?: boolean;
    author?: { screen_name?: string };
    media?: {
      all?: Array<{ type?: string }>;
    };
  } | null;
}

const FETCH_TIMEOUT_MS = 3_000;
const CACHE_TTL_S = 24 * 60 * 60;

function cacheKey(id: string): string {
  return `tweet:${id}`;
}

async function readCache(id: string): Promise<Tweet | null> {
  try {
    const raw = await redis.get(cacheKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as Tweet;
  } catch (err) {
    log("warn", "tweet_cache_read_failed", { tweet_id: id, ...serializeErr(err) });
    return null;
  }
}

async function writeCache(tweet: Tweet): Promise<void> {
  try {
    await redis.set(cacheKey(tweet.id), JSON.stringify(tweet), {
      expiration: new Date(Date.now() + CACHE_TTL_S * 1000),
    });
  } catch (err) {
    // Best-effort: a cache write failure shouldn't kill the reply path.
    log("warn", "tweet_cache_write_failed", { tweet_id: tweet.id, ...serializeErr(err) });
  }
}

function pickMedia(items: Array<{ type?: string }> | undefined): Tweet["media"] {
  const first = items?.[0]?.type;
  if (first === "photo") return "photo";
  if (first === "video") return "video";
  if (first === "gif") return "gif";
  return "none";
}

function parseFxResponse(id: string, body: FxResponse): Tweet | null {
  // Tombstones (deleted/suspended/private) come back with status.type ===
  // 'tombstone' and no text. Treat as "no enrichment available."
  const status = body.status;
  if (!status || status.type === "tombstone") return null;
  const text = typeof status.text === "string" ? status.text : "";
  const screenName = status.author?.screen_name;
  if (!screenName) return null;
  return {
    id,
    authorScreenName: screenName,
    text,
    sensitive: status.possibly_sensitive === true,
    media: pickMedia(status.media?.all),
  };
}

async function fetchFromApi(id: string): Promise<Tweet | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const rsp = await fetch(`https://api.fxtwitter.com/2/status/${id}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!rsp.ok) {
      // 401 (private), 404 (missing), 500 (upstream) — all map to "no enrichment."
      log("info", "tweet_fetch_unavailable", { tweet_id: id, http: rsp.status });
      return null;
    }
    const body = (await rsp.json()) as FxResponse;
    return parseFxResponse(id, body);
  } catch (err) {
    log("warn", "tweet_fetch_failed", { tweet_id: id, ...serializeErr(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch tweet metadata, with a Redis cache. Always fails open — any error
// returns null so the caller can fall back to a mirror-only reply.
export async function fetchTweet(id: string): Promise<Tweet | null> {
  const cached = await readCache(id);
  if (cached) return cached;
  const fresh = await fetchFromApi(id);
  if (fresh) await writeCache(fresh);
  return fresh;
}
