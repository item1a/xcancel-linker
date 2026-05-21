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

## Install

1. Visit the app's page in the Reddit App Directory.
2. Click "Install" and choose the subreddit.

No configuration required. The app needs `reddit` and `redis`
permissions, both shown at install time.

## What gets stored

A single Redis key per replied-to thing: `replied:<comment-or-post-id>`
with a 7-day TTL. No user content, no analytics, no external network
calls. See [PRIVACY.md](PRIVACY.md).

## Terms / Privacy

- [Terms of Service](TERMS.md)
- [Privacy Policy](PRIVACY.md)
