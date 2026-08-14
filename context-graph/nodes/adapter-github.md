---
id: adapter-github
kind: service
title: GitHub repository adapter
status: done
owner: ingest
spec: packages/ingest/src/github.ts
depends_on: [svc-ingest, adapter-markdown, contract-doc, contract-import-event, risk-injection, dec-untrusted-content]
---

The only one of the four connectors with a real API, and therefore the only one that can genuinely
re-sync rather than re-import (D29). Read [[adapter-markdown]] first — most of what this adapter
"does" is that adapter's work.

## The GitHub-specific code is fetching, and nothing else

Once a file's text is in hand it is Markdown. Identity, frontmatter rules, title/excerpt/folder/tag
derivation, `normalizeIngested`'s fencing, the NUL check and the failure taxonomy are all
`scanMarkdown`'s, reached through the same in-memory port a browser upload uses. `github.ts` has no
`deriveTitle` of its own, and it must not grow one — `svc-ingest` says adapters are the only
source-specific code, and a second parser that merely agreed with the first would be a second thing
to review.

Network access sits behind `GitHubPort`. Every interesting case is a failure — truncated tree, rate
limit, moved default branch, binary file wearing a `.md` extension — and none is reachable from a
test that has to hit api.github.com.

## Facts that constrain callers

- **One Source per repository**, `src-github-<owner>-<repo>`. `externalId` is the path *within* the
  repo and `README.md` exists in nearly all of them, so a shared `src-github` would let two
  repositories silently overwrite each other. This is what forced [[screen-import]] to render
  sources beyond its fixed slots.
- **Every file carries the repository's `pushed_at`.** Per-file commit dates cost one request each,
  which the unauthenticated 60/hour ceiling cannot pay. So every document from one repo shares a
  timestamp, which is why the `id` tiebreak in `docs.list` (D28) is load-bearing rather than tidy.
- **`incomplete` must be checked, not just the counts.** A truncated tree or a `maxFiles` cutoff
  produces a partial import whose numbers look exactly like a complete one. This is the failure the
  adapter is most exposed to, so the flag is returned separately and both the CLI and the web
  control state it before any count.
- **`--prune` is refused when `incomplete`.** Absence only proves deletion against a complete
  listing; pruning a partial one tombstones everything that fell outside the ceiling.
- **A rate limit aborts the run** instead of failing each remaining file — one condition with one
  fix, not two hundred misleading failures.

## Auth

No token is a first-class path: public repositories work with nothing configured, at 60
requests/hour. `GITHUB_TOKEN` raises that to 5,000 and unlocks private repos; a fine-grained token
with read-only Contents is enough, and the port has no method that could write. The token is a
bearer header and never enters a URL — query strings reach access logs, proxies and referrers.

GitHub's 403 means **both** "forbidden" and "rate limited", told apart only by
`x-ratelimit-remaining`. Conflating them sends someone to regenerate a token that was working.

## Not built

PR descriptions and Issues, which the connector row's copy also promises. Markdown files are the
whole of it today.
