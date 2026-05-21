# xcancel-bot — Privacy Policy

xcancel-bot ("the App") is designed to store the minimum data needed
to do its job.

## What we store

For each post or comment the App has replied to, the App stores a
single Redis key of the form `replied:<reddit-thing-id>` with a
7-day TTL. This key exists solely to prevent the App from replying
twice to the same item.

We do not store:
- Comment or post bodies
- Reddit usernames
- IP addresses or device information
- Any analytics or counters

Redis storage is scoped per subreddit installation by Devvit and is
not accessible to the App across installations.

## External services

The App does not make outbound HTTP requests. It only interacts with
the Reddit and Redis APIs that Devvit provides to it. The `xcancel.com`
URLs posted in replies are links — the App does not fetch them.

## Contact

For questions, contact the App's operator via the Reddit App Directory
listing or the public GitHub repository.
