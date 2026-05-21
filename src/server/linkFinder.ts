export interface TwitterUrl {
  url: string;
  path: string;
}

const HOST_RE =
  /(https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s)\]]+)/gi;

const TRAILING_PUNCT = /[.,)\]>]+$/;

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
