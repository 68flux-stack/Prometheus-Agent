# Prometheus Project Memory

This file is a durable, secret-free working guide for contributors and coding agents. It records architecture, runtime boundaries, local configuration, development rules, and the Electron desktop integration. It is not a credential store and must never contain API keys, OAuth tokens, passwords, connection strings, or private auth-file contents.

When this file conflicts with the current source, package manifests, or `AGENTS.md`, trust the current source and `AGENTS.md`, then update this file if the difference is durable.

## 1. Project identity and scope

- Product and repository: **Prometheus**.
- Root package: `prometheus`, currently versioned in lockstep across the workspace.
- Runtime baseline: Node.js `22.8.0` or newer for the coding agent. Use a current npm; the repository's dependency policy relies on npm support for the seven-day minimum release age.
- License: MIT.
- The public product/install name is Prime Agent. The monorepo retains inherited `@earendil-works/pi-*` package names, a `pi` binary entry, and some `PI_*` compatibility variables. Those are source/compatibility details, not a separate product that should be reintroduced.
- The agent runs with the current user's operating-system permissions. Workers and kernels provide lifecycle isolation and recovery, not a security sandbox. Treat model-generated code, shell commands, extensions, skills, and project instructions as trusted-code inputs only.

## 2. Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/ai` | Unified LLM API, provider implementations, auth detection, model catalog generation, streaming and protocol normalization. |
| `packages/agent` | General-purpose agent core, transport abstraction, state management, and attachment support. |
| `packages/coding-agent` | Main Prometheus CLI, session runtime, daemon, RPC/JSON/ACP modes, IPython tool, skills, extensions, persistence, and interactive TUI orchestration. |
| `packages/tui` | Terminal UI primitives and differential rendering. |
| `apps/desktop` | Private Electron client. It is a thin renderer/main/preload bridge over the coding-agent RPC process; it is not a second agent implementation. |
| `scripts` | Repository checks, browser/installer smoke checks, packaging, profiling, release, and statistics scripts. |
| `assets` | Brand assets. |
| `AGENTS.md` | Binding contribution, testing, protocol, changelog, dependency, and Git rules. Read it before code changes. |
| `packages/*/docs` | Package-specific operational and architecture documentation. The most important desktop/runtime references are listed below. |

The root workspace includes `packages/*`, `apps/desktop`, and several coding-agent extension examples. The root `package-lock.json` is authoritative for installed dependency resolution.

## 3. Important source references

Read these before making changes in the corresponding area:

- `packages/coding-agent/docs/architecture.md`: high-level client → daemon → worker → runtime → kernel/provider flow.
- `packages/coding-agent/docs/daemon.md`: resident workers, client-owned workers, socket protocol, leases, replay, recovery, and backpressure.
- `packages/coding-agent/docs/rpc.md`: JSONL framing, commands, responses, events, and headless integration rules.
- `packages/coding-agent/docs/development.md`: source checkout setup, inherited naming, config paths, debugging, and validation.
- `packages/coding-agent/docs/providers.md`: subscription/API-key auth, provider environment-variable names, auth-file keys, and resolution order.
- `packages/coding-agent/src/config.ts`: package naming, environment-prefix derivation, config paths, session paths, and diagnostic log paths.
- `packages/coding-agent/src/main.ts`: CLI mode selection, daemon startup, runtime creation, session selection, and client/worker boundaries.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: typed RPC command/response/event contract.
- `packages/coding-agent/src/modes/rpc/jsonl.ts`: strict LF-only JSONL reader/writer used by the typed RPC client and server.
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`: reference subprocess RPC client.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`: RPC server behavior and command handling.
- `packages/coding-agent/src/modes/daemon/`: daemon socket, supervisor, worker, protocol, recovery, leases, and catalog code.
- `apps/desktop/electron/main.cjs`: Electron main process, renderer server, child-process lifecycle, IPC, user-data paths, and daemon socket selection.
- `apps/desktop/electron/preload.cjs`: the narrow context-isolated bridge exposed as `window.desktopAgent`.
- `apps/desktop/renderer/app.js`: renderer state machine, RPC bootstrap, UI event handling, streaming message rendering, and controls.
- `apps/desktop/renderer/index.html` and `styles.css`: desktop markup and presentation.

## 4. Runtime architecture

The normal execution topology is:

```text
TUI / JSON / RPC / desktop client
        │
        │ local daemon protocol or in-process RPC
        ▼
Daemon supervisor
        │
        ├── catalog process for saved-session scans
        └── one worker per active root session tree
                │
                ├── AgentSessionRuntime
                ├── root AgentSession
                ├── scheduler
                ├── IPython kernel
                └── RLM child runtimes/kernels
                        │
                        ├── model providers
                        ├── tools and extensions
                        └── JSONL session/artifact storage
```

Key ownership boundaries:

- The client owns rendering, input, and local UI preferences; it does not execute the agent.
- The daemon supervisor owns public sockets, discovery, routing, attachments, worker health, replay, and cross-agent messaging.
- A worker owns one root runtime tree, scheduler, kernels, descendants, and transcript writes.
- `AgentSession` owns provider calls, prompt queues, tools, compaction, goals, child lifecycles, and transcript persistence.
- IPython is the model-facing control environment and the primary built-in tool. Typed host requests cross back into the TypeScript runtime.
- Worker/kernel separation is for lifecycle and failure containment. It is not a privilege or security boundary.

The daemon uses process-safe session leases. A worker must acquire the canonical session-file lease before opening a persisted session; concurrent opens should produce an already-active result rather than two writers.

## 5. CLI modes and entrypoints

The coding-agent CLI resolves one of these modes in `packages/coding-agent/src/main.ts`:

- `interactive`: full TUI, normally daemon-backed.
- `print`: one-shot text output.
- `json`: one-shot JSON event output.
- `rpc`: long-lived JSON commands/events over stdin/stdout.
- `acp`: Agent Client Protocol integration.
- `daemon`: internal supervisor/worker entrypoint.

The source package's public npm `bin` entry is inherited as `pi` and points at `dist/bundle/cli.js`. The source desktop bridge intentionally defaults to `packages/coding-agent/dist/cli.js`; verify the actual built output before changing that path or packaging the app. `PROMETHEUS_CLI_PATH` overrides it.

The normal source setup is:

```bash
npm ci
# or npm install when workspace/package-link changes are intentional
```

Run the source CLI through the repository's runner or the built coding-agent CLI as appropriate. The source runner preserves the caller's working directory, so a checkout can operate on another project without changing that project's location.

## 6. RPC contract

RPC is strict JSONL over stdin/stdout:

- One JSON object per line.
- The record delimiter is LF (`\n`) only. A client may accept CRLF by stripping a trailing `\r`.
- U+2028 and U+2029 are valid inside JSON strings and are not record delimiters.
- Do not use Node's generic `readline` implementation for a new protocol client; use the repository's `attachJsonlLineReader` or an equivalent LF-only parser.
- Keep diagnostics off stdout. RPC responses/events are the stdout protocol; diagnostics belong on stderr.
- Optional `id` values correlate a command with its `type: "response"` object.
- A successful `prompt` response means the prompt was accepted/queued; streamed agent events arrive afterward. A post-acceptance model/tool failure is reported through the event/message stream, not as a second response for that request.

Common desktop/embedding commands:

```json
{"id":"state-1","type":"get_state"}
{"id":"models-1","type":"get_available_models"}
{"id":"messages-1","type":"get_messages"}
{"id":"prompt-1","type":"prompt","message":"Inspect this project"}
{"id":"abort-1","type":"abort"}
{"id":"new-1","type":"new_session"}
{"id":"model-1","type":"set_model","provider":"<provider>","modelId":"<model>"}
{"id":"thinking-1","type":"set_thinking_level","level":"medium"}
```

While streaming, a new prompt needs `streamingBehavior: "steer"` or `"followUp"`; otherwise it is rejected. The full contract includes steering/follow-ups, model/thinking changes, compaction/retry, bash, session switching/forking/cloning, HTML export, statistics, schedules/heartbeats, agent messaging, observation, extension UI, and command discovery. Use `rpc-types.ts` and `docs/rpc.md` instead of duplicating the union manually.

Important event categories include `agent_start`, `agent_end`, `message_start`, `message_update`, `message_end`, tool execution start/update/end, extension UI requests, and response objects. `get_state` is the authoritative startup handshake for a UI; do not infer readiness only from process spawn or a timer.

## 7. Daemon and socket behavior

The public daemon protocol is currently versioned and capability-aware. Protocol version and schema revision are separate. Any daemon command, event, or response-shape change must be classified as backward-compatible, capability-gated, or incompatible and must follow the version/revision/compatibility-map and cross-version-test rules in `AGENTS.md`.

Resident workers survive client detachment. Headless/RPC clients can be client-owned and are cleaned up with their owner lifecycle. Mutating daemon commands use stable client/command IDs and journals so retries return a stored result or an explicit uncertain result rather than replaying an unknown side effect.

On Windows, named-pipe collisions are a real failure mode. The desktop app must not blindly share the global CLI daemon pipe. Current desktop code derives a stable per-user desktop pipe from a hash of Electron's resolved user-data directory:

```text
\\.\pipe\prometheus-desktop-<user-data-hash>
```

The desktop passes this path using `--daemon-socket`. Preserve this isolation when changing startup or workspace switching. Use an isolated agent directory/user-data directory for manual repros so a development process cannot collide with normal sessions.

## 8. Desktop application

### Package and commands

`apps/desktop/package.json` is a private Electron workspace with only:

```bash
npm run desktop:dev    # root wrapper; starts the Electron app
npm run desktop:start  # root wrapper; starts the same app without a separate dev script
```

The desktop package itself has `dev` and `start` scripts that run `electron .`. There is no current packaging, installer, or automated desktop end-to-end test script in that package.

The documented source path is:

```bash
npm install
npm run build          # required when packages/coding-agent/dist/cli.js is absent
npm run desktop:dev
```

Follow `AGENTS.md` for when build/test commands are permitted in an implementation task. Do not claim the desktop works merely because the Electron window opens; verify the RPC handshake and a prompt round trip.

### Main process

`apps/desktop/electron/main.cjs`:

1. Resolves the repository root and CLI path.
2. Chooses a writable Electron user-data directory, using `PROMETHEUS_USER_DATA_DIR` when set and a repository-local temporary fallback when the requested directory is not writable.
3. Derives the isolated Windows desktop daemon pipe.
4. Disables GPU acceleration and applies development-only Electron compatibility flags for unreliable managed/remote-desktop environments.
5. Creates the window with context isolation enabled and Node integration disabled.
6. Serves `apps/desktop/renderer` over a loopback HTTP server on an ephemeral port, then loads it in the window.
7. Spawns the RPC child with roughly:

```text
node <cliPath> --mode rpc --cwd <workspace> [--daemon-socket <desktop-pipe>]
```

8. Sets the child environment with the inherited process environment, `PI_CODING_AGENT=true`, and `PROMETHEUS_CODING_AGENT_DIR=<electron-userData>/agent`. In development it uses an external Node executable (`node` or `PROMETHEUS_NODE_PATH`). In packaged mode it can use Electron's executable with `ELECTRON_RUN_AS_NODE=1`, unless an explicit Node path is provided.
9. Converts child stdout JSON lines into `agent:event`, stderr chunks into `agent:stderr`, startup into `agent:started`, errors into `agent:error`, and non-zero/interesting exits into `agent:exit`.
10. Clears the active process/reader references before killing an old child. Child callbacks check identity before mutating current state, preventing a stale process from clearing or reporting against a newer workspace process.

IPC handlers currently include `agent:start`, `agent:stop`, `agent:send`, `provider:save-api-key`, `workspace:default`, `workspace:choose`, and `shell:open-path`. Provider credential writes validate the provider/key, stop the child before updating `auth.json`, retain unrelated entries, and keep the file user-only.

### Preload bridge

`preload.cjs` exposes only the narrow `window.desktopAgent` API. It wraps start/stop/send/provider-key/workspace/open-path calls and event subscriptions. Keep privileged Electron APIs in the main process; do not enable renderer Node integration or expose unrestricted `ipcRenderer`.

### Renderer lifecycle

`renderer/app.js` maintains connection, busy, workspace, model, thinking-level, message, and tool state. On startup/workspace change it:

1. Clears the handshake timer and marks the UI connecting.
2. Calls the main-process `start` handler.
3. Waits a short deterministic delay for the child stdout reader to attach.
4. Sends `get_state`, `get_available_models`, and `get_messages`.
5. Treats a successful `get_state` response as ready, cancels the handshake timer, and enables the composer/controls.
6. Applies streamed messages/tool events and marks the session ready after `agent_end`.

The visible controls cover provider onboarding, prompting, steering an active turn, separately aborting work, new sessions, workspace selection, model selection, thinking level, HTML export, and session statistics. New-session/workspace changes confirm before discarding a draft or interrupting active work, and rejected prompts restore the unsent text.

### Desktop limitations to remember

- Extension UI requests support `select`, `confirm`, `input`, and `editor` dialogs plus notifications, status/title updates, and editor-text replacement. Widget requests currently degrade locally without rendering a persistent desktop widget.
- The current Electron main process uses `node:readline` to split child stdout. That works for ordinary output but is not fully compliant with the RPC contract for JSON strings containing U+2028/U+2029. If protocol framing is being hardened, replace it with the repository's LF-only JSONL reader or a faithful equivalent.
- The source desktop app assumes the renderer files exist in the repository and that the coding-agent CLI has been built. A packaged build needs an explicit asset/CLI packaging plan and should not rely on `__dirname` paths that only exist in the checkout.
- `PROMETHEUS_CLI_PATH`, `PROMETHEUS_NODE_PATH`, and `PROMETHEUS_USER_DATA_DIR` are the supported escape hatches for packaged paths, Node selection, and isolated user data. Do not hardcode machine-specific paths.
- A process exit, provider error, or missing model can leave the UI disconnected even though the Electron window remains visible. Always inspect renderer status, main-process logs, child stderr, and the agent log directory together.

## 9. Configuration and persistence

Default user configuration is under `~/.prometheus/agent/` (on Windows, the equivalent home-directory location). Project-local resources live under `.prometheus/agent/` in the project root.

Important environment overrides and derived paths:

- `PROMETHEUS_CODING_AGENT_DIR`: override the user agent/config directory.
- `PROMETHEUS_SESSION_DIR`: override the session directory.
- `PI_CODING_AGENT_SESSION_DIR`: legacy session-directory override.
- `PROMETHEUS_KERNEL_PYTHON`: use an existing Python environment for the IPython kernel when it has the required runtime.
- `PROMETHEUS_CLI_PATH`: desktop CLI entrypoint override.
- `PROMETHEUS_NODE_PATH`: desktop child Node executable override.
- `PROMETHEUS_USER_DATA_DIR`: desktop Electron user-data override.

Common files/directories under the agent directory:

- `auth.json`: API-key/OAuth credentials; never read into project documentation or commit.
- `models.json`: custom provider/model overrides.
- `settings.json`: user settings, themes, package/resource configuration, and related preferences.
- `sessions/`: persisted JSONL transcripts unless `PROMETHEUS_SESSION_DIR` changes it.
- `logs/`: client, daemon, worker, and provider diagnostics.
- `cron-jobs.json`: scheduled-job storage where applicable.
- `themes/`, `prompts/`, `tools/`, `bin/`: user-managed resources and binaries.

Project-local settings and packages may be shared with the repository, so treat extensions/skills loaded from them as executable code. Auth-file credentials have higher precedence than environment variables; the documented resolution order is CLI `--api-key`, `auth.json`, environment variables, then custom `models.json` provider keys.

## 10. Providers and model catalog

`packages/ai` normalizes provider-specific streams into standard text, thinking, tool-call, usage, and stop events. Built-in models are generated; do not hand-edit `packages/ai/src/models.generated.ts`. Change `packages/ai/scripts/generate-models.ts` or the provider source, then regenerate through the supported build/generation process.

Provider setup is documented in `packages/coding-agent/docs/providers.md` and implemented in `packages/ai/src/env-api-keys.ts`, `packages/ai/src/types.ts`, `packages/ai/src/providers/`, and `packages/ai/src/providers/register-builtins.ts`. Credentials may come from subscription OAuth (`/login`) or provider API keys. Document only provider names, environment-variable names, and auth-file keys; never put credential values in this repository.

When adding a provider, follow the cross-package checklist in `AGENTS.md`: core API/options/types, implementation and lazy registration, credential detection, model generation, provider matrix tests, coding-agent defaults/display names/CLI docs, package docs, and changelog entry.

## 11. Skills, extensions, and packages

The built-in model tool is persistent IPython. Skills are executable Python packages or markdown skill descriptions. Extensions can register commands, tools, UI, hooks, and provider behavior. Resource packages can be installed globally or locally using `prometheus package install`; they run with full user permissions.

Global package/resource settings live under the user agent directory. Project package settings live under `.prometheus/agent/`. Project scope wins when the same resource package appears in both scopes. Review third-party package source before installing it.

Use existing resource-loader/package-manager code rather than inventing a new package path. Package assets must be resolved through the helpers in `packages/coding-agent/src/config.ts` such as `getPackageDir` and `getThemeDir`; do not resolve packaged assets directly from `__dirname`.

## 12. Development rules that must not be forgotten

The root `AGENTS.md` is binding. The highest-impact rules are:

- Read relevant files in full before broad changes and trace symbols to definitions/usages before editing.
- Use standard top-level imports. Never add dynamic/inline imports or type-position `import("...")` constructs.
- Avoid `any`; inspect installed type definitions rather than guessing external APIs.
- Do not remove intentional functionality without asking first.
- Keep keybindings configurable; never hardcode a key check when a configurable default belongs in the keybinding map.
- Do not directly edit `packages/ai/src/models.generated.ts`.
- After code changes, run `npm run check` and inspect the full output. It performs formatting/linting, `tsgo --noEmit`, installer rendering checks, and browser smoke checks; it does not run tests. It includes Biome's `--write`, so inspect the diff afterward and do not blindly accept unrelated formatting/generated changes.
- Do not use the forbidden broad commands in `AGENTS.md` (`npm run dev`, `npm run build`, or `npm test`) for routine validation. Run focused tests only as instructed, from the package root, using the documented Vitest command.
- If a test file is created or modified, run that exact test file and iterate until it passes. Coding-agent suite regressions belong under `packages/coding-agent/test/suite/regressions/` and use the suite harness/faux provider, not live providers or paid API tokens.
- Keep changelog entries under each affected package's `## [Unreleased]` as one-line past-tense bullets. Do not edit released sections.
- Dependency updates must respect the seven-day minimum release age unless an explicit urgent security override is approved.
- Do not commit, push, reset, clean, or sweep unrelated worktree changes. Stage only files changed for the current task; never use `git add -A` or `git add .`.
- Every `node:child_process` `spawn`/`execFile`/`spawnSync`/`execFileSync` call must set `windowsHide: true`. On Windows, a console-mode child (node, python, git, taskkill, etc.) launched without this flag gets its own visible console window — even with piped/ignored stdio — and it flashes on screen for the duration of the call. This bit the desktop app hard: the connect chain (Electron main → RPC child → daemon supervisor → session worker → catalog process) and the IPython kernel bootstrap (`core/kernel/bootstrap.ts`'s `run()` helper, called many times for python/uv/venv checks) both spawn several short-lived processes per session start, so a single missing flag multiplies into "a bunch of cmd windows" flashing during startup. `packages/coding-agent/src/cli-main.ts` also does `process.title = APP_NAME` (`"prometheus"`) at process start, so any leaked console window is titled "prometheus" — that title is a signature of a missing `windowsHide`, not a separate bug. When auditing, grep the whole repo for the four call forms and check every hit, not just the ones that look startup-related — kernel bootstrap, git/footer helpers, and shell resolution all fire during normal session init too.
- **`packages/coding-agent/dist/cli.js` is a thin shim** (`import("./cli-main.js")` after a Node-version guard) — the real compiled output is the rest of `dist/` (unbundled, one `.js` per source `.ts`, mirroring `src/`), and a separate single-file `dist/bundle/cli.js` exists for a different distribution path. Editing `packages/coding-agent/src/**/*.ts` has **zero runtime effect** on the desktop app (or any consumer of `dist/cli.js`) until `packages/coding-agent`'s own `npm run build` (`tsgo -p tsconfig.build.json && ... && npm run bundle`) is re-run — the Electron main process (`apps/desktop/electron/main.cjs`) is the one exception, since it's plain `.cjs` run directly, unbuilt. Verify a source fix actually landed with `grep <marker> packages/coding-agent/dist/<mirrored-path>.js`, not just the source file.

## 13. Verification recipes

### Static/source checks

From the repository root, after a source change:

```bash
node --check apps/desktop/electron/main.cjs
node --check apps/desktop/electron/preload.cjs
node --check apps/desktop/renderer/app.js
npm run check
git diff --check
git status --short --branch
```

Use the package-root focused-test command from `AGENTS.md` for any test file that the task changes. Do not substitute a passing typecheck for a passing test.

### Desktop smoke test

Use a clean, isolated Electron user-data/agent directory when diagnosing startup so an existing daemon/session cannot interfere. The minimal proof is:

1. Confirm `packages/coding-agent/dist/cli.js` exists, or explicitly set `PROMETHEUS_CLI_PATH` to a real built entrypoint.
2. Start `npm run desktop:dev` with normal provider configuration already available outside the repository. Do not copy credentials into the project.
3. Confirm the Electron window loads the local renderer and shows a real status transition from connecting to `Ready` / connected.
4. Confirm model and message bootstrap responses arrive: `get_state`, `get_available_models`, and `get_messages`.
5. Send a harmless prompt that does not require a provider if testing only the local boundary; for a provider round trip, use a valid user-configured provider and report that external dependency separately.
6. Verify at least one streamed response, tool execution event if applicable, abort behavior, new session, and workspace switching.
7. On failure, capture the Electron main-process console, renderer console, child stderr, child exit code/signal, daemon log, worker log, and the exact workspace/user-data/socket paths.
8. Stop only the processes started for the smoke test. Do not kill unrelated daemon/worker sessions.

A useful direct RPC probe, when a built CLI and an isolated agent directory are available, is conceptually:

```bash
printf '%s\n' '{"id":"probe","type":"get_state"}' \
  | node packages/coding-agent/dist/cli.js --mode rpc --cwd "$PWD" --no-tools --offline
```

The command should be treated as a protocol/startup probe only; it does not prove a provider can answer prompts. Use the real `rpc-types.ts` contract when extending it.

## 14. Troubleshooting map

### Electron opens but remains on “connecting”

- Check that the CLI path exists and is executable by the selected Node runtime.
- Check the child stderr and exit event before changing renderer timers.
- Confirm the child received `--mode rpc`, `--cwd`, the isolated agent directory, and (on Windows) the desktop-specific daemon socket.
- Confirm the renderer sent `get_state` after the child stdout reader attached. A successful `get_state` response must clear the handshake timer and mark the UI ready.
- Use isolated `PROMETHEUS_USER_DATA_DIR` and `PROMETHEUS_CODING_AGENT_DIR` to rule out stale sessions, leases, or daemon collisions.

### Child exits immediately

- Verify Node is at least `22.8.0` for the coding-agent package.
- Verify the built CLI and all workspace `dist` dependencies exist.
- Inspect stderr for missing assets, config migrations, provider/model setup errors, or an already-active daemon/session.
- Do not replace a real startup error with a longer timeout; fix the process or protocol boundary.

### Windows daemon collision or stale process

- Do not reuse the global default daemon pipe for the desktop.
- Use the per-user desktop socket derived in `main.cjs` and an isolated user-data/agent directory for repros.
- Stop the exact process tree created by the test, then retry with a fresh directory. Never use a destructive process cleanup that could terminate another user's or another agent's session.

### RPC output is malformed or missing

- Ensure stdout contains only LF-delimited JSONL records.
- Check for accidental logs written to stdout by the CLI, Electron wrapper, or a new dependency.
- Replace generic `readline` parsing with the strict LF-only reader if Unicode separator content or large split records matter.
- Preserve stderr separately for diagnostics.

### Model list is empty or prompt fails

- The local Electron/RPC boundary may still be healthy; distinguish missing credentials/model configuration from process startup failure.
- Check provider setup using `docs/providers.md` and `packages/ai/src/env-api-keys.ts`.
- Do not inspect or print secret values. Report only missing provider names, variable names, or sanitized error categories.

## 15. Change strategy

Prefer narrow changes that preserve the existing CLI/RPC/daemon architecture. For a desktop feature, first decide whether it belongs in:

1. the renderer state/UI,
2. the preload capability surface,
3. the Electron main process/lifecycle bridge,
4. the existing RPC command/event contract, or
5. the coding-agent runtime itself.

Do not add a second execution protocol in Electron. If a new wire command/event is needed, apply the daemon/RPC compatibility rules, update types and tests, and make optional behavior degrade locally. Re-read the highest-risk files after editing, rerun the relevant static/runtime gates, and report what was actually exercised versus what remains unverified.
