# xcancel-linker

A Reddit Devvit app that replies to new posts and comments containing 
`x.com` / `twitter.com` / `mobile.twitter.com` links with the equivalent
`xcancel.com` mirror URLs, so users without an X account (or who prefer 
not to open X) can read the linked content.

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

A few guardrails keep replies tidy:

- At most **5 mirrors** are included per reply, so a link-heavy post
  doesn't produce a wall of URLs.
- Each reply is posted at most **once** per post/comment (atomic
  dedup), so an edit or re-trigger never doubles up.
- Posts and comments older than **1 hour** at trigger time are
  ignored, so installing the app doesn't backfill old threads.

## Install

1. Visit the app's page in the Reddit App Directory.
2. Click "Install" and choose the subreddit.

No configuration required. The app needs `reddit` and `redis`
permissions, both shown at install time.

## Settings

One per-subreddit toggle is available in the install settings:

- **Include tweet previews in replies** (default: on) — Turn off if
  you'd rather the bot post bare `xcancel.com` mirror URLs without
  the author and tweet-text preview.

## What gets stored

Two Redis key shapes, both scoped to the installation:

- `replied:<comment-or-post-id>` — 7-day TTL, prevents duplicate replies.
- `tweet:<tweet-id>` — 24-hour TTL, caches the public tweet metadata
  shown in the reply preview.

No user content, no analytics. The only outbound network call is to
`api.fxtwitter.com` to fetch public tweet metadata. See
[PRIVACY.md](https://github.com/item1a/xcancel-linker/blob/master/PRIVACY.md).

## Fetch Domains

The following domains are requested for this app:

- `api.fxtwitter.com` - Used to fetch public tweet metadata (author
  handle, tweet text, and attached media type) for the reply preview.
  Results are cached in Redis for 24 hours, and any fetch failure falls
  back to posting the bare `xcancel.com` mirror URL.

## Changelog

Dates are the release date of each major update. Versions before the
first App Directory listing are grouped by the feature they shipped.

### Tweet-preview toggle — 2026-05-26

- New per-subreddit setting **Include tweet previews in replies**
  (default: on). Turn it off to post bare `xcancel.com` mirror URLs
  with no author/text preview.
- Upgraded the Devvit platform runtime to 0.13.0.

### Tweet previews — 2026-05-25

- Replies now enrich each mirror with a preview: author handle, tweet
  text (truncated at 280 chars), and a media tag (`[photo]` /
  `[video]` / `[gif]`).
- Metadata is fetched on demand from `api.fxtwitter.com` and cached in
  Redis for 24 hours. Sensitive tweets are linked without their text,
  and any fetch failure falls back to the bare mirror URL.

### Initial release — 2026-05-20

- Watches new posts and comments for `x.com`, `twitter.com`, and
  `mobile.twitter.com` links and replies with the matching
  `xcancel.com` mirror.
- Skips links whose `xcancel` (or `fxtwitter` / `vxtwitter` / `fixupx`
  / `fixvx`) mirror is already present, dedups by normalized path, and
  strips tracking parameters from generated mirrors.
- Caps each reply to the first 5 mirrors, dedups replies atomically so
  a post/comment is answered only once, and ignores submissions older
  than 1 hour.

## Terms / Privacy

- [Terms of Service](https://github.com/item1a/xcancel-linker/blob/master/TERMS.md)
- [Privacy Policy](https://github.com/item1a/xcancel-linker/blob/master/PRIVACY.md)
