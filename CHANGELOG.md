# Changelog

All notable changes to Imprint are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

## [0.3.1] — API authorization pass

Closes an authorization gap: several API routes trusted a `userId` supplied in
the query string or body, allowing unauthenticated reads/writes against another
user's data on a public deployment.

### Security
- **Every user-data route now requires auth.** New `requireOwnerOrKey` guard
  (`lib/authz.ts`): a request must carry either a NextAuth session that owns the
  `userId` or an `imp_live_` API key that resolves to it. Applied to
  `/api/memories` (GET/POST/PATCH/DELETE), `/api/rules`, `/api/sessions`,
  `/api/projects`, `/api/digest`, `/api/voice`, `/api/github`,
  `/api/memories/compress`, and `/api/memories/natural-update`.
- **`/api/keys` no longer leaks keys.** Generating, viewing (masked), or revoking
  an API key requires the owner's session — previously an unauthenticated `POST`
  with any `userId` regenerated that user's key **and returned it to the caller**.
- **Org routes gated.** Creating an org requires being signed in as its admin;
  reading org memories requires membership; adding members is admin-only.
- **Share-link hardening.** Removed the hardcoded fallback share secret (anyone
  could compute any user's share token offline); token generation now requires
  the owner's session; token comparison is constant-time. Set `SHARE_SECRET` (or
  `ENCRYPTION_SECRET`) to enable sharing.
- **Removed the legacy Clerk webhook** (`/api/webhooks/clerk`) — the app uses
  NextAuth; when `CLERK_WEBHOOK_SECRET` was unset the route accepted unverified
  payloads that could overwrite any user's profile fields.

### Changed
- **MCP/sync/stop-hook clients authenticate.** `mcp/server.js`, `mcp/sync.js`,
  and `mcp/extract-and-save.js` send `Authorization: Bearer <imp_live_ key>` from
  `IMPRINT_API_KEY` or `apiKey` in `~/.imprint/config.json`. **Breaking:** cloud
  sync now requires the key (dashboard → API Keys) — purely local usage is
  unaffected and needs no key.
- `ARCHITECTURE.md` updated to the 0.3 reality (local-first store, NextAuth,
  eight MCP tools, provider-fallback LLM stack, new auth model).

## [0.3.0] — Hybrid, local-first

Imprint is now **local-first**. The MCP server and Stop hook read and write an
on-device store and work fully offline with no account. Cloud sync (DynamoDB)
becomes an **optional, per-user mirror** controlled by a dashboard toggle — turn
it off and nothing ever leaves your machine.

### Added
- **Local store** at `~/.imprint` (zero-dependency JSON) — the source of truth on
  each machine; instant and works offline. `IMPRINT_USER_ID` is now optional;
  omit it to run 100% locally.
- **Cloud-sync toggle** — per-user "Sync on / Local only" pill in the dashboard,
  backed by `syncEnabled` on the user profile (`GET`/`PATCH /api/user`). The MCP
  server live-refreshes the flag, so flipping it takes effect without restarting
  the IDE.
- **Bidirectional, convergent sync** — new memories, edits, pins, and deletes
  propagate both ways. Cloud-id reconciliation; tombstones so deletes stick and
  are never resurrected by a later pull; a pending local edit is never clobbered.
- **New MCP tools** — `update_memory` (edit content/topic in place; syncs as a
  PATCH, no duplicate) and `sync_status` (mode, counts, pending, last sync).
- **Encryption at rest (optional)** — AES-256-GCM for the local store via
  `IMPRINT_ENCRYPTION_KEY` (scrypt-derived key, per-file salt+IV, auto-migration;
  refuses to read on a wrong/missing key rather than risk data loss).
- **On-device semantic search (optional)** — `IMPRINT_LOCAL_EMBED` enables
  transformers.js + `all-MiniLM-L6-v2` (CPU, no API key). Cloud (Jina) semantic
  search is still used in hybrid mode online.
- **Hybrid retrieval** — local search now uses BM25-lite lexical ranking
  (IDF-weighted, length-normalized) fused with embedding similarity via Reciprocal
  Rank Fusion. BM25 is the default even without embeddings (much better than naive
  keyword overlap); embeddings fuse in when enabled.
- **Test suite** — `cd mcp && npm test` (58 assertions: concurrency, encryption,
  tombstones, bidirectional edit sync), plus validation end-to-end against the
  live API.

### Changed
- All MCP tools read/write the local store first; the cloud is mirrored only when
  sync is on.
- Cross-process-safe writes via a file lock shared by the server and the Stop
  hook, with Windows `EPERM`/`EACCES`/`EBUSY` retry; the Stop hook now batches its
  writes into a single read-modify-write per turn.
- README and architecture docs rewritten around the local-first model.

### Security
- Memory content can stay entirely on-device (sync off) and encrypted at rest.

## [0.1.0]
- Initial release — cloud-backed (DynamoDB) persistent memory across MCP-capable
  IDEs, the web dashboard, and an enterprise org pool.
