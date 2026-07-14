# Imprint — System Architecture

> One persistent memory layer that lives under every AI coding agent you use — Claude Code, Cursor, Codex, Antigravity — so your context follows you across tools and machines instead of resetting every session.

**Live:** [imprint-ebon.vercel.app](https://imprint-ebon.vercel.app)

---

## System overview

```mermaid
flowchart TB
  subgraph SURF["Surfaces"]
    direction LR
    IDE["AI coding agents<br/>Claude Code · Cursor · Codex · Antigravity"]
    DASH["Dashboard<br/>memory graph · analytics · rules"]
    ORG["Enterprise<br/>shared org pool · BYOK"]
  end

  subgraph CAP["Capture — local-first"]
    direction LR
    MCP["MCP server<br/>8 tools · stdio"]
    HOOK["Stop + PreCompact hooks<br/>guaranteed LLM extraction"]
    LOCAL[("Local store<br/>~/.imprint — source of truth")]
  end

  subgraph API["API — Next.js on Vercel"]
    direction LR
    MEM["/api/memories<br/>save · search · pin · dedup"]
    SESS["/api/sessions · rules · org"]
    AUTH["NextAuth (Google OAuth)<br/>or Bearer imp_live_ API key"]
  end

  subgraph INTEL["Intelligence"]
    direction LR
    GROQ["Groq LLM<br/>extract + AI rerank"]
    JINA["Jina embeddings<br/>1024-dim vectors"]
    RANK["rank · dedup · pin<br/>relevance + durability"]
  end

  DB[("DynamoDB — single table<br/>USER#id · MEMORY#ts · TTL")]

  IDE --> MCP
  IDE --> HOOK
  MCP --> LOCAL
  HOOK --> LOCAL
  LOCAL -. "optional sync (API key)" .-> MEM
  DASH --> MEM
  ORG --> MEM
  MCP --> MEM
  HOOK --> MEM
  MEM --> AUTH
  MEM --> GROQ
  MEM --> JINA
  MEM --> RANK
  GROQ --> DB
  JINA --> DB
  RANK --> DB
  MEM --> DB
```

*Legend: data flows **down** to save (write path) and **up** to retrieve (read path). Every surface reads and writes the same store.*

---

## The five layers

### 1. Surfaces
- **AI coding agents** — Claude Code, Cursor, Codex, Antigravity, and any MCP-capable IDE. Each registers the MCP server in its own config file (`~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`).
- **Dashboard** — Next.js web app at `/dashboard`: live memory graph, source analytics, session history, and per-topic memory rules.
- **Enterprise** — a shared org memory pool; every member's session receives personal **and** org memories. Bring-your-own Anthropic key, AES-256 encrypted.

### 2. Capture — local-first, two layers, never loses a fact
- **Local store** (`mcp/local-store.js`) — memories live on your machine under `~/.imprint`, work fully offline with no account, and remain the source of truth. Cloud sync (`mcp/sync.js`) is an optional, per-user, bidirectional mirror.
- **MCP server** (`mcp/server.js`, stdio) exposes eight tools: `get_memories`, `save_memory`, `search_memories`, `delete_memory`, `pin_memory`, `summarize_session`, `update_memory`, `sync_status`. Tool descriptions instruct the agent to retrieve with `query` at session start and save proactively.
- **Stop + PreCompact hooks** (`mcp/extract-and-save.js`) fire after every response and before context compaction, running LLM extraction so memories are captured **even when the model forgets to call `save_memory`**.

### 3. API — Next.js on Vercel (serverless)
- `/api/memories` — `GET` (semantic / keyword / optimize), `POST` (direct save + batch extraction), `PATCH` (pin / edit), `DELETE`.
- `/api/sessions`, `/api/rules`, `/api/org`, `/api/user`, `/api/keys`.
- **NextAuth.js** authentication (Google OAuth) for the dashboard; MCP/sync/webhook callers authenticate with a revocable `imp_live_` API key (`Authorization: Bearer`). Every user-data route requires one of the two (`lib/authz.ts`).

### 4. Intelligence
- **Multi-provider LLM fallback** (`lib/llm.ts`) — extraction, contradiction detection and memory search fail over automatically across **Groq → Cerebras → Google Gemini**; a rate-limit on one provider transparently falls through to the next.
- **Jina** embeds every memory at 1024 dimensions (`retrieval.passage` for stored facts, `retrieval.query` for searches).
- **Ranking / dedup / pin** — pinned float to the top, recency decay (~14-day half-life), access boost; dedup on save (prefix + cosine > 0.92).

### 5. Storage
- **Local JSON store** under `~/.imprint` (source of truth, optional at-rest encryption).
- **DynamoDB single-table** cloud mirror when sync is on. Memories carry a 30-day TTL when unpinned; **pinned memories drop their TTL and are permanent**.

---

## Data flows

### Save (write path)

```mermaid
sequenceDiagram
  participant U as You (in IDE)
  participant A as Agent
  participant H as Stop hook
  participant API as /api/memories
  participant J as Jina
  participant DB as DynamoDB
  U->>A: chat / code
  A->>API: save_memory(fact)
  H-->>API: extract + save (guaranteed)
  API->>J: embed(content)
  API->>API: dedup — prefix + cosine > 0.92
  API->>DB: put (TTL 30d; none if pinned)
```

### Retrieve (read path)

```mermaid
sequenceDiagram
  participant A as Agent (session start)
  participant API as /api/memories
  participant J as Jina
  participant G as Groq
  participant DB as DynamoDB
  A->>API: get_memories(query = first message)
  API->>DB: fetch user memories
  API->>J: embed(query)
  API->>API: cosine rank
  alt embeddings missing / no match
    API->>API: keyword fallback
    API->>G: AI rerank zero-score candidates
  end
  API->>API: always include pinned
  API-->>A: relevant memories injected
```

---

## Retrieval pipeline — 3-tier cascade

| Tier | Method | Score | When |
|------|--------|-------|------|
| 1 | Jina embedding cosine similarity | 0.0–1.0 | memory has a stored vector |
| 2 | Keyword match (content + keywords) | 0.25–0.5 | no vector, query words match |
| 3 | Groq AI rerank | 0.15 | no vector, no keyword match |

Pinned memories are merged into **every** result set, pinned-first — they can never be filtered out by relevance limits.

---

## Data model — DynamoDB single table

| Item | PK | SK | Key fields |
|------|----|----|------------|
| Memory | `USER#userId` | `MEMORY#createdAt#memoryId` | content, topic, pinned, keywords, confidence, source, embedding, contradicts[], ttl |
| Session | `USER#userId` | `SESSION#createdAt#sessionId` | title, messageCount, memoriesExtracted |
| Memory rules | `USER#userId` | `MEMORY_RULES` | rules[] (label, topic, enabled, keywords, pattern) |
| User | `USER#userId` | `PROFILE` | tier, encryptedApiKey, orgId |
| Org | `ORG#orgId` | `PROFILE` | name, memberIds[] |

TTL: 30 days for unpinned memories, none for pinned.

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend + Dashboard | Next.js 16 (App Router), Vercel |
| Auth | NextAuth.js (Google OAuth) + `imp_live_` API keys for MCP/sync |
| Local store | JSON under `~/.imprint` (offline-capable source of truth) |
| Database | AWS DynamoDB (single-table, optional cloud mirror) |
| Memory extraction | Groq → Cerebras → Gemini fallback + regex fallback |
| Embeddings / retrieval | Jina AI (1024-dim) |
| MCP server | Node.js, `@modelcontextprotocol/sdk` |
| Capture hooks | Groq API + regex fallback |

---

## Why it wins

- **One store, every surface.** The same DynamoDB table feeds four IDEs, the dashboard, and an enterprise pool. Switch editors — keep your memory. No competitor spans IDEs like this.
- **Two-layer capture.** Agent calls *and* a guaranteed Stop/PreCompact hook — belt and suspenders, so a fact is never lost to a forgetful model.
- **Relevance, not recency.** A 3-tier retrieval cascade with always-injected pinned facts solves "pull the *right* memory," not just the latest.
- **Durable by design.** Pinned = permanent (no TTL); unpinned decays at 30 days; saves are de-duplicated so the store stays clean.
- **Serverless, scale-to-zero.** DynamoDB + Vercel functions = near-zero idle cost, instant scale. Enterprise BYOK keeps data and keys customer-owned.

---

## Security

- Every user-data API route requires either a NextAuth session that **owns** the `userId` or an `imp_live_` API key that resolves to it (`lib/authz.ts` — `requireOwner` / `requireOwnerOrKey`). A `userId` in the query string or body is never trusted on its own.
- API keys are generated, viewed (masked) and revoked only by the signed-in owner; MCP, sync, stop-hook and webhook clients send them as `Authorization: Bearer`.
- Share links are HMAC tokens derived from a server-side secret (`SHARE_SECRET`, no fallback) and compared in constant time; generating a link requires the owner's session.
- Local-first privacy: with sync off, no memory content ever leaves the machine. Optional at-rest encryption for the local store; AES-256 encryption for stored provider keys.
- Memory rules default privacy-first (personal / health / relationships off by default).
- Memories namespaced per `userId`; org memories isolated under `ORG#orgId`, member-gated; org membership changes are admin-only.
- AI prompts treat stored memories as untrusted data — instructions hidden inside a memory are never followed.
