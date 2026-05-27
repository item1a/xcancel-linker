import type { Tweet } from "./fxtwitter.ts";

// One reply line group per mirror. Each item is either enrichable (has a tweet)
// or mirror-only (tweet fetch failed, ID couldn't be extracted, etc.).
export interface ReplyItem {
  mirrorUrl: string;
  tweet: Tweet | null;
}

const TEXT_MAX = 140;
const ELLIPSIS = "…";

function mediaTag(media: Tweet["media"]): string {
  if (media === "photo") return " [photo]";
  if (media === "video") return " [video]";
  if (media === "gif") return " [gif]";
  return "";
}

function truncate(text: string): string {
  // Normalize whitespace so multi-line tweets render as a single quoted line.
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TEXT_MAX) return flat;
  return flat.slice(0, TEXT_MAX - 1).trimEnd() + ELLIPSIS;
}

function renderItem(item: ReplyItem): string {
  const { mirrorUrl, tweet } = item;
  if (!tweet) return mirrorUrl;
  // Sensitive tweets: skip text entirely so we don't echo NSFW or graphic
  // content into a thread that might not expect it. Mirror + media tag only.
  if (tweet.sensitive) {
    return `**@${tweet.authorScreenName}**${mediaTag(tweet.media)}\n${mirrorUrl}`;
  }
  const text = truncate(tweet.text);
  const tag = mediaTag(tweet.media);
  // No blockquote: the bold @author already signals "from a tweet," and a
  // bare line keeps the same left margin as the mirror URL below it.
  const head = text
    ? `**@${tweet.authorScreenName}**: ${text}${tag}`
    : `**@${tweet.authorScreenName}**${tag}`;
  return `${head}\n${mirrorUrl}`;
}

export function renderReply(items: ReplyItem[]): string {
  return items.map(renderItem).join("\n\n");
}
