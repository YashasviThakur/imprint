You are working in the Imprint repo — a local-first persistent-memory layer for AI coding IDEs (Next.js 16 App Router, an MCP server under `mcp/`, DynamoDB optional cloud mirror). This is a real, pre-existing product; we are extending it to be Codex-native for OpenAI Build Week.

Before writing any code, read these files: `BUILD_WEEK.md` (the full spec — the source of truth for this session), `ARCHITECTURE.md`, `lib/llm.ts`, `mcp/server.js`, `mcp/local-store.js`, `mcp/extract-and-save.js`, and `mcp/install.cjs`. Also read `AGENTS.md` in the repo root — note that it exists and we will replace it (item 6), so treat its current save-every-5-messages rules as legacy, not as instructions to follow now.

## What we're building
Items 1–6 in `BUILD_WEEK.md`, IN THIS ORDER. Item 7 (the eval) I'll handle separately — don't build it unless I ask.

1. GPT-5.6 as the primary LLM provider in `lib/llm.ts` (OpenAI chat-completions shape; keep Groq/Cerebras/Gemini as fallbacks).
2. `npx imprint connect codex` installer (extend `mcp/install.cjs`).
3. Codex lifecycle hooks for automatic capture — SessionStart, Stop, PreCompact, UserPromptSubmit (skip PostToolUse).
4. Project-aware memory: add `scope`, `repository`, `source` fields + scoped retrieval.
5. Two structured MCP tools: `save_checkpoint` and `get_project_context`.
6. Replace `AGENTS.md` with the Codex-focused version in the spec.

## How I want you to work
- **Plan first, per item.** Before editing for an item, show me a short plan: which files change and how. Wait for my "go" before you edit. Don't batch multiple items into one plan.
- **One item at a time.** Finish an item fully — code + a quick self-check — before starting the next.
- **Verify after every item:** run `npm run build` and `cd mcp && npm test`. If either breaks, fix it before moving on. Report the result to me.
- **Match the existing code.** Follow the conventions already in these files (the provider-fallback pattern in `lib/llm.ts`, the tool-registration style in `mcp/server.js`, the config-loading in `mcp/local-store.js`). Don't restructure things that aren't in scope.
- **Item 3 needs the real Codex hook API.** Before writing the hook adapter, check your own current Codex documentation for the exact hook event names, config location, and payload shape — don't assume the names in the spec are exact; confirm them, and tell me if they differ from what `BUILD_WEEK.md` says.
- **Stay in scope.** The "explicitly OUT of scope" list in the spec (dashboard workspace view, org redesign, audit logs, app-server, team memory) — don't build those. If something tempting comes up, note it as future work and move on.
- **Secrets:** never hardcode keys. New env vars (`OPENAI_API_KEY`, `OPENAI_MODEL`) go through the existing env pattern; document them where the other env vars are documented.

## Definition of done for this session
All six items implemented, `npm run build` green, `mcp` tests green, and each new env var / command documented. We're on the `feat/codex-native` branch; keep commits scoped per item with clear messages.

Start now: read the files listed above, then give me the plan for item 1 only.
