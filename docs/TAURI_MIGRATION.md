# Tauri migration plan (v1.0 goal)

Status: plan only. No Tauri code exists yet. Numbers below were measured from the v0.8.1 tree.

## Why bother
Electron ships a full Chromium (~100 MB+) and ClawCode already depends on the system Edge for the
WebChat bridge (v0.6.1). Tauri would cut the installer size and memory use. It is **not** free:
the entire main process is Node/TypeScript and would need a Rust (or sidecar) replacement.

## What has to move
| Area | Size | Tauri answer |
|---|---|---|
| IPC handlers | 68 `ipcMain.handle` across 15 namespaces (`hf` 12, `skills` 7, `accounts` 7, `webchat` 5, `updater` 5, `convos` 5, `app` 5, `config` 4, `opencode` 4, `psandbox` 4, others ≤3) | Rewrite as Tauri commands, or keep as a Node sidecar and proxy (see Phase 1) |
| `window.claw` preload bridge | `electron/preload.ts`, 139 lines | One thin `src/lib/bridge.ts` that exposes the same `window.claw` shape over `invoke`, so React code does not change |
| Tools (`electron/tools`) | 488 lines | Largest single port. Path-safety, `edit_file` fuzzy match, `run_command`, `git` all need Rust equivalents with the same tests |
| WebChat bridge | express server + Playwright drivers (claude, chatgpt, gemini, grok, deepseek) | Playwright has no Rust port. **Keep as a Node sidecar.** |
| Secrets | Electron `safeStorage` (`config:setApiKey`) | OS keychain via `keyring` crate or Tauri stronghold; needs a one-time migration of the stored cipher |
| Process sandbox | `process-sandbox.ts`, 360 lines, Windows restricted user | Port logic to Rust `std::process` + same Windows APIs, or leave in sidecar |
| Auto-update | `electron-updater` | `tauri-plugin-updater` (different signing and manifest format) |
| Main-to-renderer events | 8 `webContents.send` sites | Tauri `emit` / `listen` |

## Phases (each ends with a shippable build)
1. **Shell swap, Node sidecar.** Tauri window loads the existing Vite bundle. Package the current
   `electron/*` logic as a single Node sidecar (pkg/bun/`node` SEA) exposing the 68 handlers over
   stdio or localhost IPC. `bridge.ts` forwards `window.claw.*` to it. Zero rewrite risk, proves the
   renderer works under WebView2. Expect size win to be modest because the sidecar bundles Node.
2. **Port the hot, simple pieces to Rust.** `config`, `workspace`, `convos`, `app`, `net`, `providers`.
   Keep each handler's request/response shape identical; run the same tests against both.
3. **Port tools.** `read/write/list/move/delete`, `edit_file`, `run_command`, `git`. Carry over the
   behaviors that were hard-won in 0.8.1: workspace path escape check, fuzzy edit fallback,
   process-tree kill on timeout, output cap, git allowlist.
4. **Secrets and updater.** Keychain migration, then `tauri-plugin-updater` with a new signing key.
5. **Decide on the sidecar.** WebChat (Playwright) and possibly the sandbox stay Node. Final app is
   Rust core + one Node sidecar. If that is unacceptable, WebChat has to be dropped or rewritten
   on a Rust CDP client, which is a separate project.

## Risks
- **WebView2 vs Chromium differences** (CSS, `navigator.clipboard`, drag/drop). Test on Windows 10 and 11 first.
- **No test suite exists** in the repo. Porting 68 handlers and ~490 lines of tools without
  regression tests is the main danger. Write handler contract tests *before* phase 2.
- **Playwright sidecar size** erodes the main benefit of leaving Electron.
- **Updater signing key** is a one-way door: lose it and users cannot auto-update.
- Cross-compiling the Windows build needs Rust + MSVC toolchain on the build machine.

## Go / no-go
Do phase 1 as a time-boxed spike (small). If WebView2 renders cleanly and the sidecar installer is
not meaningfully smaller than today's portable `.exe`, stop and stay on Electron.
