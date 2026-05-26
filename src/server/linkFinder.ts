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

// Strip query string, fragment, and trailing slash from a path. X's tracking
// params (s, t, ref_src, …) don't affect tweet identity, so two URLs that
// differ only in trackers should produce the same mirror.
function normalizePath(p: string): string {
  let s = p;
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function tweetPathKey(p: string): string {
  return normalizePath(p).toLowerCase();
}

function fixerPathKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(FIXER_HOST_RE)) {
    const raw = m[1];
    if (!raw) continue;
    out.add(tweetPathKey(raw.replace(/\\/g, "").replace(TRAILING_PUNCT, "")));
  }
  return out;
}

export function extractTwitterUrls(text: string): TwitterUrl[] {
  const out: TwitterUrl[] = [];
  for (const m of text.matchAll(HOST_RE)) {
    const raw = m[1];
    if (!raw) continue;
    // Strip Reddit markdown escapes: raw selftext stores '_' as '\\_' to
    // prevent italicization, so 'x.com/AST_SpaceMobile' arrives as
    // 'x.com/AST\\_SpaceMobile'. Backslashes aren't valid in URL paths
    // (per RFC), so removing them is safe and yields a clickable mirror.
    const url = raw.replace(/\\/g, "").replace(TRAILING_PUNCT, "");
    const slash = url.indexOf("/", url.indexOf("://") + 3);
    const path = slash >= 0 ? url.slice(slash + 1) : "";
    if (path.length === 0) continue;
    out.push({ url, path });
  }
  return out;
}

export interface MirrorMatch {
  mirrorUrl: string;
  tweetId: string | null;
}

export interface FindMirrorsResult {
  items: MirrorMatch[];
  /** How many twitter URLs the regex matched before dedup. */
  rawCount: number;
}

export function findMirrors(text: string): FindMirrorsResult {
  const seen = new Set<string>();
  const items: MirrorMatch[] = [];
  // Case-insensitive haystack so "HTTPS://Xcancel.com/..." counts as present.
  // Trailing slashes are handled naturally: `includes("…/1")` matches "…/1/".
  const haystack = text.toLowerCase();
  const fixers = fixerPathKeys(text);
  const raw = extractTwitterUrls(text);
  for (const { path } of raw) {
    const cleanPath = normalizePath(path);
    if (cleanPath.length === 0) continue;
    const mirror = `https://xcancel.com/${cleanPath}`;
    const mirrorLc = mirror.toLowerCase();
    if (seen.has(mirrorLc)) continue;
    if (haystack.includes(mirrorLc)) continue;
    if (fixers.has(tweetPathKey(path))) continue;
    seen.add(mirrorLc);
    items.push({ mirrorUrl: mirror, tweetId: tweetId(cleanPath) });
  }
  return { items, rawCount: raw.length };
}

// Thin adapter — tests assert on the mirror-URL list directly.
export function missingMirrors(text: string): string[] {
  return findMirrors(text).items.map((m) => m.mirrorUrl);
}
