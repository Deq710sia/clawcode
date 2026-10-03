# ClawCode

A **universal agentic coding harness** — GUI-based, packaged as a Windows `.exe`. Built with **Electron + React + TypeScript**. Combines the best patterns of Claude Code, OpenCode, and Codex into one tool that works with **any model**: API providers, local servers (Ollama / LM Studio), **free web chats via headless Chrome**, and the OpenCode backend.

![Electron](https://img.shields.io/badge/Electron-29-9feaf9) ![React](https://img.shields.io/badge/React-18-61dafb) ![TS](https://img.shields.io/badge/TypeScript-5-3178c6) ![License](https://img.shields.io/badge/license-MIT-7c5cfc)

## What makes it universal

| Provider type | Examples | API key needed? |
|---|---|---|
| **API** | OpenAI, Anthropic, Z.ai GLM-5.2, OpenRouter, Groq, Together, Mistral, DeepSeek, xAI | Yes |
| **Local servers** | Ollama, LM Studio, vLLM | No |
| **WebChat Bridge** | claude.ai, chatgpt.com, gemini.google.com, grok.com, deepseek.com | No — uses your web login |
| **OpenCode backend** | Any provider OpenCode supports | Depends on provider |

The WebChat Bridge is the killer feature: it runs a stealth-hardened headless Chromium for each web chat, logs in with your saved profile, drives the web UI, and exposes it as an OpenAI-compatible `/v1/chat/completions` endpoint. **Free web credits → agentic API.**

## Features

- **Streaming chat** with markdown + code highlighting
- **9 tools**: list_files, read_file, write_file, edit_file, run_command, delete_file, move_file, **update_plan**, **web_search**
- **Agentic loop**: plan → act → verify, up to 24 tool rounds per turn, with retry-on-error and long-context truncation
- **Plan panel**: live todo list the agent maintains as it works
- **Tool-call visualization** with collapsible JSON args/result cards
- **Unified diffs** rendered inline for every `edit_file` call
- **File tree** sidebar
- **Settings UI** with provider picker, web chat login manager, OpenCode toggle
- **Cursor-inspired** dark theme (navy + violet accents)
- **Clean-room** — no code copied from Claude Code, Cursor, Aider, or OpenCode

## Build the `.exe`

### Prerequisites

- **Node.js 18+** and **npm 9+**
- **Windows 10/11 x64** (for the actual `.exe` build)
- ~1.5 GB free disk (Electron + Playwright Chromium cache)

### Steps

```powershell
git clone <your-fork>
cd clawcode
npm install        # auto-installs Playwright Chromium
npm run dist
```

Output:

```
release/
├── ClawCode-0.2.0-x64.exe            # NSIS installer
├── ClawCode-0.2.0-portable.exe       # single-file portable exe
└── win-unpacked/
```

### Dev mode

```powershell
npm run dev
```

## First-run guide

1. **Pick a workspace folder** — *Open Folder* in the top bar.
2. **Open Settings** (gear icon) → **Provider** tab:
   - Pick a provider card (OpenAI, Z.ai GLM, Ollama, WebChat, etc.)
   - Enter your API key (encrypted with Windows DPAPI; not needed for local servers or web chats)
3. **(Optional) Web Chats tab** — click "Log in" next to each web chat you want to use. A visible Chromium window opens; log in normally; the profile is saved. Future queries run headless.
4. **(Optional) OpenCode tab** — install OpenCode (`curl -fsSL https://opencode.ai/install | bash`), click "Start OpenCode", then select the "OpenCode Backend" provider to route the agent loop through it.
5. **Chat** — ask ClawCode to explore, build, or fix. Tool calls appear as collapsible cards; plans update live; file edits show diffs inline.

## Architecture

```
clawcode/
├── electron/                        # Main process
│   ├── main.ts                      # Window, IPC, config, bridge/server init
│   ├── preload.ts                   # contextBridge → window.claw API
│   ├── opencode.ts                  # OpenCode subprocess manager
│   ├── providers/index.ts           # 17 provider presets
│   ├── tools/index.ts               # 9 tools + LCS diff generator
│   └── webchat/
│       ├── bridge.ts                # Playwright orchestrator + stealth
│       ├── profiles.ts              # Persistent Chromium profiles per site
│       ├── server.ts                # Local OpenAI-compatible HTTP server
│       └── drivers/
│           ├── base.ts              # BaseDriver contract + helpers
│           ├── claude.ts            # claude.ai driver
│           ├── chatgpt.ts           # chatgpt.com driver
│           ├── gemini.ts            # gemini.google.com driver
│           ├── grok.ts              # grok.com driver
│           └── deepseek.ts          # chat.deepseek.com driver
├── src/                             # Renderer (React)
│   ├── components/
│   │   ├── TopBar, Sidebar, ChatPanel, MessageInput
│   │   ├── Message (with ToolCallCard + DiffView)
│   │   ├── SettingsModal (4 tabs: Provider, WebChats, OpenCode, Advanced)
│   │   ├── PlanPanel (live todo list)
│   │   ├── WelcomeModal, StatusBar
│   ├── lib/
│   │   ├── api.ts                   # OpenAI-compatible streaming client
│   │   └── store.ts                 # Zustand store + agentic loop
│   ├── styles/globals.css           # Cursor-inspired theme
│   └── types.ts                     # Shared types + window.claw interface
└── package.json                     # electron-builder config
```

### Security model

- `contextIsolation: true`, `nodeIntegration: false`
- All file/shell ops happen in the main process; the renderer only sees `window.claw`
- Path arguments are resolved against the workspace root and rejected if they escape
- API keys are encrypted with Electron `safeStorage` (DPAPI on Windows)
- WebChat profiles stored under `userData/webchat-profiles/<id>/` — each site gets its own isolated Chromium profile
- CSP blocks remote scripts; `connect-src` allows `https:`/`http:` (so local LLM servers work)

### WebChat Bridge flow

```
1. User clicks "Log in" on Claude.ai row
2. Bridge launches headful Chromium with persistent profile dir
3. User logs in normally (2FA, captcha — all normal)
4. Bridge polls isLoggedIn() until success
5. Profile saved; session stays open
6. Subsequent queries: bridge launches headless (or reuses session)
7. Driver navigates, types message, polls for new tokens
8. Tokens streamed back as SSE chunks to /v1/chat/completions
9. ClawCode's existing client consumes the SSE stream
```

### Agentic loop

```
sendUserMessage(text)
   ↓
[round N] stream chat/completions
   ↓ on delta: append to assistant message
   ↓ on tool_calls: emit cards, execute sequentially
   ↓ each tool result pushed as role:'tool' message
   ↓ update_plan tool calls sync the live PlanPanel
   ↓ loop back to stream with extended history
   ↓
[exit] no more tool_calls, or MAX_TOOL_ROUNDS (24), or abort
```

Long-context handling: when history exceeds ~100K chars, the system prompt + first user message + last 20 messages are kept, with long tool results truncated to summaries.

## ToS notice

Using web UIs via headless browser automation may violate the provider's Terms of Service. The WebChat Bridge is provided for accessibility and research purposes. Use with your own accounts, at your own risk. ClawCode does not bypass paywalls, captchas, or rate limits — it just drives the same UI you'd use manually.

## Clean-room notice

No code was copied from Claude Code, Cursor, Aider, Codex, or OpenCode. All tool implementations, the diff generator, the streaming SSE parser, the Playwright drivers, and the UI components are written from scratch. OpenCode is invoked as an external subprocess (MIT-licensed) when the user opts into that backend.

## License

MIT.
