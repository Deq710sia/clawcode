# ClawCode — Pickup Prompt

> **Purpose**: This file gives a fresh AI agent (Claude, GPT, Gemini, etc.) complete context
> about the ClawCode project — what it is, what's been done, what's broken, what needs fixing,
> and all lessons learned across multiple development sessions. Read this top to bottom before
> making any changes.

---

## What is ClawCode

ClawCode is a **universal agentic coding harness** — a desktop GUI app that lets you chat with
any AI model (API providers, local LLM servers, or free web chats via headless browser) and have
it read, write, and edit files in your workspace, run shell commands, and search the web.

**Repo**: https://github.com/Deq710sia/clawcode
**Current version**: v0.8.0 (with uncommitted fixes for v0.8.1)
**Stack**: Electron 29 + React 18 + TypeScript 5 + Vite 5
**Build**: `npm install && npm run build && npm run dist` → portable .exe for Windows 10/11 x64

---

## Architecture Overview

```
clawcode/
├── electron/                    # Main process (Node.js)
│   ├── main.ts                  # App entry, IPC handlers, window, auto-updater, net proxy
│   ├── preload.ts               # Context bridge → window.claw API (bundled as .cjs via esbuild)
│   ├── scripts/build-preload.mjs  # Bundles preload as CommonJS (Electron can't load ESM preloads)
│   ├── conversations.ts         # Save/load chat history to disk
│   ├── accounts/index.ts        # Multi-account manager with usage tracking + failover
│   ├── opencode.ts              # OpenCode subprocess manager
│   ├── process-sandbox.ts       # Codex-style restricted user sandbox (ACLs + firewall)
│   ├── sandbox.ts               # Windows Sandbox (.wsb) VM launcher
│   ├── huggingface.ts           # HF model search/download + Cookbook (hardware-aware fitting)
│   ├── providers/index.ts       # 17 provider presets (API, local, webchat, opencode)
│   ├── skills/index.ts          # GitHub skill search + install via git clone
│   ├── tools/index.ts           # 9 tools: list/read/write/edit/delete/move files, run_command, update_plan, web_search
│   └── webchat/
│       ├── bridge.ts            # Playwright session manager (uses system Edge, not bundled Chromium)
│       ├── server.ts            # Express HTTP server on 127.0.0.1:7777 (OpenAI-compatible)
│       ├── toolprotocol.ts      # Text protocol for web chat tool calling (JSON in code blocks)
│       ├── profiles.ts          # Persistent Chromium profile dirs per web chat
│       └── drivers/             # Per-site selectors: claude, chatgpt, gemini, grok, deepseek
├── src/                         # Renderer (React)
│   ├── App.tsx                  # Shell + bootstrap + ErrorBoundary
│   ├── components/
│   │   ├── TopBar.tsx           # Custom title bar with window controls
│   │   ├── Sidebar.tsx          # 4 tabs: History, Files, Skills, Models
│   │   ├── ChatPanel.tsx        # Chat messages + header (model, new chat, reset)
│   │   ├── MessageInput.tsx     # Composer with slash commands + keyboard nav
│   │   ├── Message.tsx          # Message rendering + tool call cards + code copy
│   │   ├── PlanPanel.tsx        # Live todo list from update_plan tool
│   │   ├── AccountSwitcher.tsx  # Dropdown for multi-account switching
│   │   ├── ConversationHistory.tsx  # Past conversations grouped by date
│   │   ├── SettingsModal.tsx    # 7 tabs: Provider, Accounts, Web Chats, OpenCode, Sandbox, Updates, Advanced
│   │   ├── SkillsBrowser.tsx    # GitHub skill search + install
│   │   ├── ModelsBrowser.tsx    # HuggingFace + Cookbook model browser
│   │   ├── SandboxPanel.tsx     # Process sandbox + Windows Sandbox config
│   │   ├── UpdatePanel.tsx      # Auto-updater UI
│   │   ├── StatusBar.tsx        # Context usage, account usage, model, version
│   │   ├── ConfirmDialog.tsx    # Custom confirm dialog (replaces native confirm())
│   │   ├── ErrorBoundary.tsx    # Catches render crashes
│   │   └── WelcomeModal.tsx     # First-run onboarding
│   ├── lib/
│   │   ├── api.ts               # OpenAI-compatible streaming client + tool schemas + system prompt
│   │   ├── store.ts             # Zustand store: agentic loop, failover, conversations, accounts
│   │   └── netfetch.ts          # fetch() proxy through main process (avoids CORS)
│   ├── styles/globals.css       # Full theme: teal accent, warm dark base, Geist font
│   └── types.ts                 # Shared TypeScript types + window.claw interface
├── .github/workflows/build-windows.yml  # CI: builds NSIS installer on Windows runner
└── package.json                 # electron-builder config, scripts, deps
```

---

## Key Design Decisions (and why)

1. **Preload is .cjs, not .js** — `package.json` has `"type": "module"`, so Electron treats .js
   as ESM. Electron's preload loader doesn't support `import` in sandboxed preloads. Solution:
   `scripts/build-preload.mjs` bundles `electron/preload.ts` as `dist-electron/preload.cjs` via esbuild.

2. **System Edge, not bundled Chromium** — Playwright's bundled Chromium had a 3-way path mismatch
   (postinstall downloaded to one path, extraResources bundled from another, PLAYWRIGHT_BROWSERS_PATH
   pointed to a third). The packaged .exe crashed on launch. Fix: `channel: 'msedge'` uses the
   Edge installation already on every Windows 10/11 machine. No download, no bundle, no path issues.

3. **Net proxy for CORS** — The renderer loads from `file://` (origin "null"), so direct `fetch()`
   to LLM APIs is blocked by CORS. All LLM requests route through the main process via
   `net.fetch` (Chromium's network stack). `src/lib/netfetch.ts` provides a `proxyFetch()` that
   returns a real streaming `Response`.

4. **WebChat tool protocol** — Web chats have no function-calling API. The bridge teaches the
   model a JSON-in-code-blocks convention: `{"tool_call": {"name": "...", "arguments": {...}}}`.
   `toolprotocol.ts` builds a text prompt with system instructions + tool schemas + conversation
   history, and parses replies back into OpenAI `tool_calls`.

5. **Multi-account failover** — Each web chat service can have N accounts. Usage tracking per
   account with known free-tier limits. On 429/rate-limit, marks account exhausted, finds next
   available account, re-sends full history — zero context loss.

6. **Conversation persistence** — Chats auto-save to `userData/conversations/*.json` after every
   agent turn. On restart, the History sidebar shows all past conversations grouped by date.

7. **Link navigation fix** — `will-navigate` and `will-redirect` events are intercepted to prevent
   clicking a link in chat from navigating the Electron window (which "stuck" the app). All http(s)
   links open in the system browser.

---

## Uncommitted Changes (v0.8.1 in progress)

These 4 files have been modified but NOT yet committed or pushed:

### 1. `electron/webchat/toolprotocol.ts` — Agent synthesis fix
Added "CRITICAL — CONVERSATIONAL SYNTHESIS" rules to the tool protocol prompt:
- After receiving tool results, model MUST write a natural language response
- Never end a turn with just tool calls — always wrap up with plain text
- Only call another tool if the task genuinely requires more info

### 2. `src/lib/api.ts` — System prompt fix
Added rules 9 and 10 to the system prompt:
- Rule 9: ALWAYS SYNTHESIZE after tool results
- Rule 10: NEVER END WITH JUST TOOLS — every turn must end with plain text
- Also added: if a tool fails twice, STOP and explain instead of retrying

### 3. `electron/skills/index.ts` — Skills cleanup
Removed fake/hardcoded entries: caveman, ponytail, universal-modder, odysseus, aider, clawhub.
Only real installable repos remain (awesome-claude-code, claude-code-agents).

### 4. `src/components/ChatPanel.tsx` — Chat header rewrite
- Added prominent "New" button (creates new conversation)
- Added "Clear" (reset) button
- Shows conversation title in header instead of static "Chat" label

---

## Known Issues (prioritized)

### P0 — Critical UX problems

1. **Skills browser sucks** — Only 2 hardcoded entries left after cleanup. Needs to default to
   GitHub search on load, not the curated list. The GitHub search should auto-populate with
   "claude code skills" on first open. The "Featured" tab should be secondary.

2. **No model selector in chat header** — The model name in the status bar is static. Users need
   a dropdown to switch models mid-chat without going to Settings. Should show all available
   providers + models in a compact dropdown. Like Cursor/Windsurf's model picker at the bottom
   of the chat.

3. **Settings lockout** — After initial setup, some users can't change their model or provider.
   The settings modal should always be accessible (gear icon in topbar works, but the flow
   inside is confusing). The provider grid should let you switch providers with one click and
   immediately use the new one.

4. **Onboarding flow is confusing** — The Welcome modal + workspace picker + settings flow
   doesn't make sense as a sequence. Should be: (1) pick workspace, (2) pick provider/model,
   (3) start chatting. All in one flow, skippable.

### P1 — Important but not blocking

5. **Thinking/reasoning panel** — No visibility into the model's thinking trace. Need a
   collapsible "Thinking..." panel above the response (like Claude Code's extended thinking).
   For API providers that support `thinking` content (Z.ai, Anthropic), display it. For web
   chats, detect "thinking" indicators in the DOM.

6. **edit_file reliability** — Uses exact string match. Fails on whitespace/CRLF differences.
   Needs: (a) normalize whitespace before matching, (b) fuzzy matching fallback, (c) better
   error messages that show what was expected vs what was found.

7. **Cross-platform command execution** — Commands use bash syntax (`&&`, `||`) but Windows
   uses PowerShell. The `run_command` tool should detect the platform and either: (a) wrap
   commands in `bash -c` on Windows (if Git Bash is available), or (b) translate common
   bash patterns to PowerShell equivalents, or (c) use `cmd.exe /c` instead of PowerShell.

8. **Error recovery loops** — When a tool fails, the agent repeats similar parameters rather
   than stepping back. The system prompt should include: "If a tool fails twice with similar
   arguments, STOP. Explain the problem to the user and ask for guidance."

9. **No git integration** — Unlike Aider, there's no auto-commit after edits. No safety net
   of snapshots. Should add: (a) optional auto-commit after each successful edit_file, (b)
   `git diff` display, (c) `git rollback` tool.

### P2 — Polish

10. **Feels like a fake app (Electron)** — User explicitly wants Tauri migration. Tauri apps
    are 96% smaller, 75% less RAM, use native webview. This is a v1.0 milestone — too big
    for an incremental release but should be the next major architecture change.

11. **UI still looks slopcoded** — Despite the teal accent + Geist font + warm dark base,
    the overall composition still feels AI-generated. Need: (a) more intentional spacing,
    (b) better empty states, (c) consistent border-radius, (d) real visual hierarchy.

12. **No diff preview/review** — When edit_file runs, the diff is shown inline in the tool
    call card but there's no accept/reject flow. Should add: (a) side-by-side diff view,
    (b) accept/reject buttons, (c) revert capability.

13. **No terminal panel** — Shell command output is shown in tool call cards but there's no
    dedicated terminal panel. Users expect to see command output in real-time, not after
    completion.

---

## Lessons Learned (from user testing + competitor research)

### From the user's actual usage session (Gemini via WebChat bridge):
- The agent **completed tool calls but didn't synthesize a response** — it treated the tool
  result as the end of its responsibility. The user had to explicitly ask "thoughts on the
  program?" to get the agent to talk. This is a prompt issue (fixed in uncommitted changes).
- The agent's self-evaluation was **surprisingly accurate** — it correctly identified that
  edit_file uses naive string substitution, that the web bridge relies on fragile DOM
  selectors, and that error recovery loops are a problem.
- The agent called the system prompt "lying to itself about model capability" — fair criticism.
  The prompt assumes reliable multi-step planning and strict JSON tool calls from web models
  that don't naturally maintain state across turns.

### From competitor research (Claude Code, Cursor, Windsurf, Aider, Pi, Hermes):
- **Claude Code** has: projects sidebar, conversation history, extended thinking display,
  auto-update indicator, clean onboarding
- **Cursor/Windsurf** have: model selector at bottom of chat, context cards, diff review
  panel, git integration, clean split-pane layout
- **Aider** has: AST-aware diff editing, auto-commit after every edit, repo map, git
  rollback — the gold standard for edit reliability
- **Pi** has: cross-provider handoffs, streaming thinking content, OAuth providers, 40+
  provider integrations
- **Hermes** has: context window estimation per model, auto-scale config, self-improving
  skills, task scheduling
- **taste-skill (antislop)** has: Three Dials (variance/motion/density), design system map,
  pre-flight check, "read the room before anything else"

### From the antislop guide:
- Don't default to: AI-purple gradients, centered hero over dark mesh, three equal feature
  cards, generic glassmorphism, infinite-loop micro-animations, Inter + slate-900
- Do: read the brief, pick a real design system, be honest about borrowed patterns
- ClawCode currently uses: teal accent (not violet ✓), warm dark base (not slate ✓), Geist
  font (not Inter ✓), but still has centered hero empty state (✗), glassmorphism on modal
  backdrop (minor ✗)

### From deep code audits (v0.5.1):
- 50+ bugs found across the codebase, 4 critical in process-sandbox (all fixed)
- The diff generator had wrong hunk header math (fixed)
- The bridge had a session.busy leak that permanently stuck webchat profiles (fixed)
- The net proxy had a listener leak across renderer reloads (fixed)
- config:set allowed writing raw apiKeyCipher (security hole, fixed)

---

## Build & Release Process

```bash
# 1. Install deps (no Playwright Chromium download needed — uses system Edge)
cd clawcode
npm install

# 2. Typecheck
npm run typecheck

# 3. Build (compiles electron TS + bundles preload as .cjs + builds Vite renderer)
npm run build

# 4. Build portable .exe (Linux can cross-compile portable, not NSIS)
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win portable --x64

# 5. For NSIS installer, push a tag — GitHub Actions builds it on a Windows runner:
git tag v0.X.Y
git push origin v0.X.Y

# 6. Create release on GitHub, upload portable.exe + latest.yml
```

**latest.yml format** (for auto-updater):
```yaml
version: 0.X.Y
files:
  - url: ClawCode-0.X.Y-portable.exe
    sha512: <sha512sum>
    size: <bytes>
path: ClawCode-0.X.Y-portable.exe
sha512: <sha512sum>
releaseDate: "<ISO date>"
```

**GitHub token**: The user's token was used in previous sessions but has been in chat history.
**Do NOT put tokens in any committed file.** The user will provide a new one if needed.
The repo is at `github.com/Deq710sia/clawcode`, user is `Deq710sia`.

---

## What To Do Next (Priority Order)

1. **Commit the 4 uncommitted files** (agent synthesis fix, skills cleanup, chat header)
2. **Fix SkillsBrowser** — default to GitHub search, auto-search "claude code skills" on load
3. **Add model selector dropdown** in chat header (quick-switch without settings)
4. **Fix onboarding flow** — one-screen workspace + provider pick, skippable
5. **Build + release v0.8.1**
6. **Add thinking/reasoning panel** (collapsible, above response)
7. **Improve edit_file** — normalize whitespace, fuzzy match fallback
8. **Add git integration** — auto-commit after edits, diff preview, rollback
9. **Plan Tauri migration** for v1.0

---

## File Quick Reference

| File | Purpose | Key function/class |
|---|---|---|
| `electron/main.ts` | App entry, IPC, window | `createWindow()`, `registerIpc()` |
| `electron/preload.ts` | Context bridge | `window.claw` API |
| `electron/tools/index.ts` | 9 agent tools | `handleToolCall()`, `safePath()`, `editFile` |
| `electron/webchat/bridge.ts` | Playwright sessions | `query()`, `login()`, `launchSession()` |
| `electron/webchat/server.ts` | HTTP bridge server | `startBridgeServer()`, model routing |
| `electron/webchat/toolprotocol.ts` | Text tool protocol | `buildPrompt()`, `parseReply()` |
| `electron/accounts/index.ts` | Multi-account | `getAvailableAccount()`, `recordUsage()` |
| `electron/conversations.ts` | Chat persistence | `saveConversation()`, `listConversations()` |
| `electron/huggingface.ts` | HF + Cookbook | `searchModels()`, `estimateFit()`, `downloadModel()` |
| `electron/process-sandbox.ts` | ACL sandbox | `setupSandbox()`, `runCommandSandboxed()` |
| `src/lib/api.ts` | LLM streaming client | `streamChat()`, `TOOL_SCHEMAS`, system prompt |
| `src/lib/store.ts` | Zustand state | `sendUserMessage()`, agentic loop, failover |
| `src/lib/netfetch.ts` | CORS proxy | `proxyFetch()` |
| `src/components/ChatPanel.tsx` | Chat UI | messages, scroll, suggestions |
| `src/components/SettingsModal.tsx` | Settings (7 tabs) | provider, accounts, webchats, sandbox, updates |
