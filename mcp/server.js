#!/usr/bin/env node

/**
 * Imprint MCP server — local-first, with optional cloud sync.
 *
 * The local JSON store (local-store.js) is the source of truth on this machine,
 * so Imprint works fully offline and needs no account. When the user has a
 * userId configured AND sync is turned ON (website toggle, cached locally), each
 * write is also mirrored to the hosted API (DynamoDB) and cloud memories are
 * pulled down at startup. When sync is OFF — or no userId is set — nothing ever
 * leaves the machine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  loadConfig,
  saveConfig,
  localSave,
  localGet,
  localSearch,
  localSearchSemantic,
  localDelete,
  localPin,
  localUpdate,
  localStats,
  STORE_DIR,
} from "./local-store.js";
import { pushPull, refreshSyncFlag, mirrorSave, mirrorDelete, mirrorPin, mirrorUpdate } from "./sync.js";
import { available as localEmbedAvailable, MODEL_NAME as EMBED_MODEL } from "./embed-local.js";

const API_BASE = process.env.IMPRINT_API_BASE || "https://imprint-ebon.vercel.app";
const API_KEY  = process.env.IMPRINT_API_KEY;   // optional secure path (revocable)
const PLATFORM = process.env.IMPRINT_PLATFORM || "claude-code";

// Resolved at startup — from env, then local config, then API-key lookup.
let USER_ID = process.env.IMPRINT_USER_ID || loadConfig().userId || null;
// `false` only when the user explicitly turned sync off on the website.
let SYNC_ENABLED = loadConfig().syncEnabled;

// Hybrid = we have an identity AND the user wants cloud sync on.
function hybrid() { return !!USER_ID && SYNC_ENABLED; }

const REQUEST_TIMEOUT_MS = 15_000;  // abort a request that hangs (e.g. Vercel cold start)
const MAX_ATTEMPTS = 3;             // total attempts before surfacing the error
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cloud API helpers (only used in hybrid mode) ──────────
// fetch with a hard timeout + bounded retry. Vercel functions cold-start, so the
// first request after idle can hang or return 5xx; retrying with backoff turns
// those transient failures into success. Safe: GET/DELETE/PATCH are idempotent and
// POST /api/memories is de-duplicated server-side.
async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
      if (res.ok) return await res.json();
      const body = await res.text().catch(() => "");
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) { lastErr = new Error(`API error ${res.status}`); await sleep(300 * attempt); continue; }
      throw new Error(`API error ${res.status}: ${body}`);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function cloudSemantic(query, limit = 20) {
  const data = await apiFetch(
    `/api/memories?userId=${encodeURIComponent(USER_ID)}&semantic=${encodeURIComponent(query)}&limit=${limit}`
  );
  return data.memories || [];
}

// ── Local context optimizer (token-budget trim, pinned first) ──
function optimizeLocal(memories, budget) {
  const pinned = memories.filter((m) => m.pinned);
  const rest   = memories.filter((m) => !m.pinned);
  const out = [...pinned];
  let tokens = pinned.reduce((a, m) => a + Math.ceil((m.content || "").length / 4), 0);
  for (const m of rest) {
    const t = Math.ceil((m.content || "").length / 4);
    if (tokens + t > budget) break;
    out.push(m);
    tokens += t;
  }
  return out;
}

function format(memories) {
  if (!memories.length) return "No memories found.";
  const pinned = memories.filter((m) => m.pinned);
  const rest   = memories.filter((m) => !m.pinned);
  let out = "";
  if (pinned.length) {
    out += "📌 PINNED (always remember):\n";
    out += pinned.map((m) => `  • [${m.topic}] ${m.content}`).join("\n") + "\n\n";
  }
  const byTopic = rest.reduce((a, m) => { (a[m.topic] = a[m.topic] || []).push(m); return a; }, {});
  for (const [t, ms] of Object.entries(byTopic)) {
    out += `${t.toUpperCase()}:\n`;
    out += ms.map((m) => `  • ${m.content}`).join("\n") + "\n";
  }
  return out.trim();
}

// ── Startup: establish identity + mode, run a sync if hybrid ──
async function bootstrap() {
  // Secure path: resolve userId from an API key if no userId is known yet.
  if (!USER_ID && API_KEY) {
    try {
      const data = await apiFetch("/api/v1/memories?limit=1");
      USER_ID = data.userId;
      saveConfig({ userId: USER_ID });
    } catch (e) {
      console.error(`[Imprint MCP] API-key lookup failed: ${e.message}`);
    }
  }

  if (USER_ID) {
    // Learn the latest website toggle state (sends only the userId).
    const enabled = await refreshSyncFlag(USER_ID, API_BASE);
    if (enabled !== undefined) SYNC_ENABLED = enabled;
    else SYNC_ENABLED = loadConfig().syncEnabled;
    saveConfig({ userId: USER_ID, syncEnabled: SYNC_ENABLED });
  }

  if (hybrid()) {
    const { pulled, pushed } = await pushPull(USER_ID, API_BASE);
    const count = localGet({ limit: 1000 }).length;
    console.error(
      `[Imprint MCP] ✓ Ready — hybrid mode (cloud sync ON). ${count} memories local ` +
      `(pulled ${pulled}, pushed ${pushed}). Store: ${STORE_DIR}`
    );
  } else if (USER_ID) {
    const count = localGet({ limit: 1000 }).length;
    console.error(
      `[Imprint MCP] ✓ Ready — local-only mode (cloud sync OFF). ${count} memories. ` +
      `Turn sync on at ${API_BASE}/dashboard. Store: ${STORE_DIR}`
    );
  } else {
    const count = localGet({ limit: 1000 }).length;
    console.error(
      `[Imprint MCP] ✓ Ready — local mode (no account). ${count} memories on this machine. ` +
      `Store: ${STORE_DIR}. Set IMPRINT_USER_ID + enable sync to back up to the cloud.`
    );
  }
}

await bootstrap();

// ── Live sync-toggle refresh ──────────────────────────────
// The website toggle lives in the cloud profile; re-check it periodically so
// flipping it takes effect WITHOUT restarting the IDE. When it flips on, run a
// sync immediately so the machine catches up. unref() so it never keeps the
// process alive on its own.
const SYNC_REFRESH_MS = 5 * 60 * 1000;
if (USER_ID) {
  const timer = setInterval(async () => {
    try {
      const was = SYNC_ENABLED;
      const enabled = await refreshSyncFlag(USER_ID, API_BASE);
      if (enabled === undefined) return; // offline — keep current state
      SYNC_ENABLED = enabled;
      if (!was && enabled) {
        const { pulled, pushed, deleted } = await pushPull(USER_ID, API_BASE);
        console.error(`[Imprint MCP] cloud sync turned ON — synced (pulled ${pulled}, pushed ${pushed}, deleted ${deleted}).`);
      } else if (was && !enabled) {
        console.error("[Imprint MCP] cloud sync turned OFF — staying local-only.");
      }
    } catch { /* best-effort */ }
  }, SYNC_REFRESH_MS);
  if (timer.unref) timer.unref();
}

// ── MCP Server ────────────────────────────────────────────

const server = new McpServer({ name: "imprint", version: "2.0.0" });

server.tool(
  "get_memories",
  "Retrieve stored memories about the user. Call at the start of every conversation. ALWAYS pass `query` = the user's first message so semantic search returns relevant memories, not just recent ones. Pass `optimize=true` to fit a token budget.",
  {
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general","all"]).optional(),
    limit: z.number().optional(),
    query: z.string().optional().describe("REQUIRED for relevance: pass the user's first message or current task. Runs semantic/keyword search — returns memories ranked by relevance, not recency."),
    optimize: z.boolean().optional().describe("Trim memories to fit a token budget (default 2000 tokens). Pinned memories are always included first."),
    budget: z.number().optional().describe("Token budget when optimize=true. Default: 2000."),
  },
  async ({ topic, limit = 60, query, optimize = false, budget = 2000 }) => {
    try {
      let memories;
      if (query) {
        // Prefer cloud semantic search (Jina embeddings) when syncing & online;
        // otherwise use local search — semantic if on-device embeddings are
        // enabled, else keyword (localSearchSemantic handles that fallback).
        if (hybrid()) {
          try { memories = await cloudSemantic(query, Math.min(limit, 20)); }
          catch { memories = await localSearchSemantic(query, Math.min(limit, 20)); }
        } else {
          memories = await localSearchSemantic(query, Math.min(limit, 20));
        }
      } else if (optimize) {
        memories = optimizeLocal(localGet({ limit: 1000 }), budget);
      } else {
        memories = localGet({ topic: topic && topic !== "all" ? topic : undefined, limit });
      }
      const pinCount = memories.filter((m) => m.pinned).length;
      const header = query
        ? `${memories.length} relevant memories for "${query}" (${pinCount} pinned):\n\n`
        : optimize
        ? `${memories.length} memories within ~${budget}-token budget (${pinCount} pinned):\n\n`
        : `${memories.length} memories (${pinCount} pinned):\n\n`;
      return { content: [{ type: "text", text: header + format(memories) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "save_memory",
  "Save a durable fact about the user. Call PROACTIVELY — the moment you learn anything worth recalling in a future session: their name, role, tech stack, projects, goals, deadlines, preferences, or decisions. Don't wait until the end of the conversation; save as soon as the fact appears. Saves are de-duplicated (exact and paraphrase), so re-saving something already known is safe and cheap.",
  {
    content: z.string().describe("The fact to remember — a single, self-contained sentence (e.g. 'The user is building Imprint, a persistent memory layer')."),
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general"]),
    pinned: z.boolean().optional().describe("Pin to inject into EVERY future session regardless of relevance. Use for always-true essentials: name, main project, key preferences. Pinned memories never expire."),
  },
  async ({ content, topic, pinned = false }) => {
    try {
      const { memory, deduped } = localSave({ content, topic, pinned, source: PLATFORM });

      // Mirror to the cloud when sync is on; capture contradiction warnings the
      // server detects. Best-effort: offline saves stay local and retry later.
      let contradictions = [];
      if (hybrid() && !deduped) {
        const r = await mirrorSave(USER_ID, API_BASE, memory);
        contradictions = (r && r.contradictions) || [];
      }

      let text = `✅ Saved${deduped ? " (already known)" : ""}: [${topic}] ${content}${pinned ? " 📌" : ""}`;
      if (contradictions.length) {
        text += `\n\n⚠️ This may contradict ${contradictions.length} existing memor${contradictions.length === 1 ? "y" : "ies"}:`;
        for (const c of contradictions) text += `\n  • "${c.existingMemoryContent}" — ${c.explanation}`;
        text += `\n\nBoth are now flagged in your Imprint dashboard. Tell me which is correct and I'll update it.`;
      }
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "search_memories",
  "Search memories by natural language, ranked by relevance. ALWAYS call this BEFORE answering any personal question about the user (health, job, preferences, past decisions, what they're working on) — never answer such questions from assumptions. Also call it when the conversation shifts to a topic the session-start memories didn't cover.",
  { query: z.string().describe("Natural language query — pass the user's question verbatim, e.g. 'what frameworks does the user prefer?' or 'what is the user building?'") },
  async ({ query }) => {
    try {
      let results;
      if (hybrid()) {
        try { results = await cloudSemantic(query, 10); }
        catch { results = await localSearchSemantic(query, 10); }
      } else {
        results = await localSearchSemantic(query, 10);
      }
      if (!results.length) return { content: [{ type: "text", text: `No memories found for "${query}".` }] };
      return { content: [{ type: "text", text: `${results.length} results for "${query}":\n\n${format(results)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_memory",
  "Delete a memory. Use when the user asks you to forget something.",
  { memoryId: z.string(), createdAt: z.string().optional() },
  async ({ memoryId, createdAt }) => {
    try {
      const deleted = localDelete(memoryId); // also records a tombstone
      if (deleted && hybrid()) {
        // Use the local record's own createdAt; fall back to the caller's.
        await mirrorDelete(USER_ID, API_BASE, { memoryId: deleted.memoryId, createdAt: deleted.createdAt || createdAt });
      }
      return { content: [{ type: "text", text: deleted ? "✅ Memory deleted." : "No matching memory found." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "pin_memory",
  "Pin or unpin a memory. Pinned memories are always injected into every session.",
  { memoryId: z.string(), createdAt: z.string().optional(), pinned: z.boolean() },
  async ({ memoryId, createdAt, pinned }) => {
    try {
      const updated = localPin(memoryId, pinned);
      if (updated && hybrid()) {
        await mirrorPin(USER_ID, API_BASE, { memoryId: updated.memoryId, createdAt: updated.createdAt || createdAt, pinned: updated.pinned });
      }
      return { content: [{ type: "text", text: updated ? `✅ Memory ${pinned ? "📌 pinned" : "unpinned"}.` : "No matching memory found." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "summarize_session",
  "Save what was learned this conversation as memories. Call at the end of any session where you learned important facts about the user.",
  {
    key_facts: z.array(z.string()).describe("Specific facts to save as individual memories — one sentence each, max 8."),
    summary: z.string().optional().describe("Optional free-text summary — saved as a single memory if no key_facts provided."),
  },
  async ({ key_facts = [], summary }) => {
    try {
      const saved = [];
      const facts = key_facts.length ? key_facts.slice(0, 8) : (summary ? [summary] : []);
      for (const fact of facts) {
        try {
          const { memory, deduped } = localSave({ content: fact, topic: "general", pinned: false, source: "session-summary" });
          if (!deduped) {
            saved.push(fact);
            if (hybrid()) await mirrorSave(USER_ID, API_BASE, memory);
          }
        } catch {}
      }
      return {
        content: [{
          type: "text",
          text: saved.length
            ? `✅ Session saved: ${saved.length} memor${saved.length === 1 ? "y" : "ies"} stored.\n${saved.map((f) => `  • ${f}`).join("\n")}`
            : "No new memories were saved (either no facts provided or all were duplicates).",
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "update_memory",
  "Correct or rewrite an existing memory's content or topic (e.g. the user says 'actually, change that to…'). Edits the same memory in place and syncs the change to the cloud — it won't create a duplicate.",
  {
    memoryId: z.string(),
    content: z.string().optional().describe("New content for the memory."),
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general"]).optional(),
  },
  async ({ memoryId, content, topic }) => {
    try {
      const updated = localUpdate(memoryId, { content, topic });
      if (updated && hybrid()) {
        await mirrorUpdate(USER_ID, API_BASE, { memoryId: updated.memoryId, createdAt: updated.createdAt, content: updated.content, topic: updated.topic });
      }
      return { content: [{ type: "text", text: updated ? `✅ Updated: [${updated.topic}] ${updated.content}` : "No matching memory found." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "sync_status",
  "Report where Imprint stores memories and the cloud-sync state. Use when the user asks whether their memories are local-only, synced, backed up, or 'where is my data'.",
  {},
  async () => {
    try {
      const stats = localStats();
      const cfg = loadConfig();
      const mode = hybrid()
        ? "hybrid — local store + cloud sync ON (backed up to the cloud)"
        : USER_ID
        ? "local-only — cloud sync OFF (nothing leaves this machine)"
        : "local — no account (nothing leaves this machine)";
      const embedOn = await localEmbedAvailable();
      const lines = [
        `Mode: ${mode}`,
        `Store: ${STORE_DIR}`,
        `Memories: ${stats.total} (${stats.pinned} pinned)`,
        `Local search: ${embedOn ? `hybrid — BM25 + on-device embeddings via RRF (${EMBED_MODEL})` : "BM25 keyword (set IMPRINT_LOCAL_EMBED=1 + install transformers.js for hybrid semantic)"}`,
        `Pending upload: ${stats.dirty} · pending deletions: ${stats.pendingDeletes}`,
        `Last cloud sync: ${cfg.lastSyncAt || "never"}`,
        USER_ID
          ? `Account: ${USER_ID}`
          : "No account — set IMPRINT_USER_ID and enable sync in the dashboard to back up across devices.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
