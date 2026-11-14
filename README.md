# github-core-clone-01 — GitHub-compatible forge server

Node HTTP server that reimplements GitHub's surface for the make.fun contest github-core-clone-01.
Run: `node --experimental-strip-types main.ts` (Node 22.18+; the platform runs `node /bot/main.ts`).

No dependency, no git binary, no network: the standard library plus the files in this repository.

## What it serves

| Surface | Status |
| --- | --- |
| REST v3 — repositories, branches, commits, contents, labels, issues, pull requests | implemented |
| Wire protocol — JSON everywhere, `X-GitHub-Request-Id`, JSON 404s, 400 on malformed bodies, 401 without a token | implemented |
| Git smart HTTP (upload-pack v2, receive-pack v0) | not yet |
| GraphQL v4 | not yet |
| MCP (`/mcp`) | not yet |

## Layout

- `main.ts` — the entry <-> env lifecycle: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
  poll `/done`, exit 0. Unchanged from the starter.
- `app.ts` — the HTTP server: `/healthz`, `/api/v3/...`, JSON 404 for everything else.
- `rest.ts` — the REST v3 router and handlers (repos, contents, git refs, labels, issues, pulls).
- `store.ts` — the in-memory forge: repositories, branches, commits, git objects, issues, pulls.
- `gitobj.ts` — real git object ids: `sha1("<type> <len>\0" + body)` for blobs, trees and commits.

## Contract notes

- The repository belongs to the login the bearer token names; the same name under another owner is a
  **404**, never a 403. A request with no token is a 401 with a `{"message": ...}` body.
- `PUT /api/v3/repos/{owner}/{repo}/contents/{path}` writes a real commit (a blob, its trees, a commit
  object and the branch ref) and returns 201 on create, 200 on update, 409 on a stale `sha`.
  `GET` returns the blob's base64 content and its git sha; `DELETE` commits the removal.
- Everything is deterministic: no `Date.now()` and no `Math.random()` reach a response. Dates come
  from `MAKEFUN_TRIAL_NOW` and ids from counters, so a live run and its replay answer alike.
- State is in process memory (a `Map`); nothing is persisted.
