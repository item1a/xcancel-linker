export interface TwitterUrl {
  url: string;
  path: string;
}

const TWEET_ID_RE = /^[^/]+\/status\/(\d+)/i;

// Extract the numeric tweet id from a TwitterUrl path like 'user/status/123…'.
// Returns null for non-status URLs (profile links, hashtag pages, etc.) and
// for paths whose post-status segment isn't an integer (a defensive guard).
export function tweetId(path: string): string | null {
  const m = TWEET_ID_RE.exec(path);
  return m?.[1] ?? null;
}

const HOST_RE =
  /(https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s)\]]+)/gi;

// Twitter-embed-fixer hosts. If one of these already points at the same tweet,
// the user has already solved the "view without X" problem and we shouldn't pile on.
const FIXER_HOST_RE =
  /https?:\/\/(?:fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/([^\s)\]]+)/gi;

const TRAILING_PUNCT = /[.,!?;:)\]>]+$/;

function tweetPathKey(p: string): string {
  let s = p.toLowerCase();
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function fixerPathKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(FIXER_HOST_RE)) {
    const raw = m[1];
    if (!raw) continue;
    out.add(tweetPathKey(raw.replace(TRAILING_PUNCT, "")));
  }
  return out;
}

export function extractTwitterUrls(text: string): TwitterUrl[] {
  const out: TwitterUrl[] = [];
  for (const m of text.matchAll(HOST_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const url = raw.replace(TRAILING_PUNCT, "");
    const slash = url.indexOf("/", url.indexOf("://") + 3);
    const path = slash >= 0 ? url.slice(slash + 1) : "";
    if (path.length === 0) continue;
    out.push({ url, path });
  }
  return out;
}

export function missingMirrors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Case-insensitive haystack so "HTTPS://Xcancel.com/..." counts as present.
  // Trailing slashes are handled naturally: `includes("…/1")` matches "…/1/".
  const haystack = text.toLowerCase();
  const fixers = fixerPathKeys(text);
  for (const { path } of extractTwitterUrls(text)) {
    const mirror = `https://xcancel.com/${path}`;
    const mirrorLc = mirror.toLowerCase();
    if (seen.has(mirrorLc)) continue;
    if (haystack.includes(mirrorLc)) continue;
    if (fixers.has(tweetPathKey(path))) continue;
    seen.add(mirrorLc);
    out.push(mirror);
  }
  return out;
}
