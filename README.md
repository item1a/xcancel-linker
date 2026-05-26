# xcancel-bot

A Reddit Devvit app (registered as `xcancel-linker` on Reddit) that replies
to new posts and comments containing `x.com` / `twitter.com` /
`mobile.twitter.com` links with the equivalent `xcancel.com` mirror URLs,
so users without an X account (or who prefer not to open X) can read the
linked content.

## What it does

When a moderator installs the app on a subreddit, the app watches new
post and comment submissions. For every Twitter-family URL it finds, it
posts a reply containing the equivalent `xcancel.com/<path>` mirror.
URLs that already have their xcancel mirror present in the same
post/comment are skipped, so no spammy duplicate mirrors.

The reply also includes a brief preview of each tweet — author handle,
tweet text, and a tag for any attached media (`[photo]` / `[video]` /
`[gif]`) — so readers can decide whether to click without leaving
Reddit. Tweet metadata is fetched on demand from `api.fxtwitter.com`
and cached for 24 hours. Sensitive tweets are linked without their
text. If the fetch fails for any reason, the reply falls back to just
the mirror URL.

## Install

1. Visit the app's page in the Reddit App Directory.
2. Click "Install" and choose the subreddit.

No configuration required. The app needs `reddit` and `redis`
permissions, both shown at install time.

## What gets stored

Two Redis key shapes, both scoped to the installation:

- `replied:<comment-or-post-id>` — 7-day TTL, prevents duplicate replies.
- `tweet:<tweet-id>` — 24-hour TTL, caches the public tweet metadata
  shown in the reply preview.

No user content, no analytics. The only outbound network call is to
`api.fxtwitter.com` to fetch public tweet metadata. See
[PRIVACY.md](PRIVACY.md).

## Terms / Privacy

- [Terms of Service](TERMS.md)
- [Privacy Policy](PRIVACY.md)
