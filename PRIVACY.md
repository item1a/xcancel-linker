# xcancel-bot — Privacy Policy

xcancel-bot ("the App") is designed to store the minimum data needed
to do its job.

## What we store

For each post or comment the App has replied to, the App stores a
single Redis key of the form `replied:<reddit-thing-id>` with a
7-day TTL. This key exists solely to prevent the App from replying
twice to the same item.

To avoid re-fetching the same tweet on every link, the App also caches
fetched tweet metadata under `tweet:<tweet-id>` for 24 hours. The
cached value contains only the public tweet content that appears in
the App's reply (author handle, tweet text, sensitivity flag, media
type).

We do not store:
- Comment or post bodies
- Reddit usernames
- IP addresses or device information
- Any analytics or counters

Redis storage is scoped per subreddit installation by Devvit and is
not accessible to the App across installations.

## External services

The App makes outbound HTTP requests to **`api.fxtwitter.com`** to
fetch public metadata (author handle, tweet text, media type) for the
specific tweet IDs referenced in the post or comment being replied to.
This is the only external service the App contacts.

- No Reddit user identifiers, subreddit names, IP addresses, or
  comment bodies are sent in these requests.
- The only information transmitted is the public numeric tweet ID
  parsed from the linked URL.
- Responses are cached in Redis for 24 hours per tweet ID to minimize
  upstream traffic.
- `api.fxtwitter.com` is operated by the FixTweet project, not by us.
  Its own privacy practices apply to its handling of inbound requests.

The App does not fetch `xcancel.com` URLs that appear in replies —
those are links.

## Contact

For questions, contact the App's operator via the Reddit App Directory
listing or the public GitHub repository.
