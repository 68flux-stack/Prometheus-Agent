<h3 align="center">
Prometheus: A Self-Improving RLM Agent
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-agent">prime-agent</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

<p align="center">
  <a href="https://github.com/68flux-stack/Prometheus-Agent/actions/workflows/ci.yml">
    <img src="https://github.com/68flux-stack/Prometheus-Agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/68flux-stack/Prometheus-Agent/actions/workflows/release.yml">
    <img src="https://github.com/68flux-stack/Prometheus-Agent/actions/workflows/release.yml/badge.svg" alt="Release" />
  </a>
  <a href="https://www.npmjs.com/package/prometheus-agent">
    <img src="https://img.shields.io/npm/v/prometheus-agent.svg" alt="npm" />
  </a>
</p>

Prometheus is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Prometheus can refine through small, evidence-backed updates, local to the session by default.

Prometheus combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** persistent IPython is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

Prometheus started as a fork of [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) and has since added:

- **A desktop app:** the Electron client under `apps/desktop` (below) does not exist upstream.
- **Deep research:** `/research` fans out subagents to read sources, triangulate across independent domains, and write a citation-verified report, with an optional quota mode for "find N candidates" briefs.
- **Execution modes and change review:** `plan`, `workspace`, and `unrestricted` modes with `/permissions` gate what the agent can touch; `/changes` reviews, accepts, or rejects workspace edits against a durable baseline.
- **Background jobs and worktree isolation:** `rlm.jobs` runs long shell commands in the background with progress, logs, and stdin; subagents can opt into isolated Git worktrees with reviewable, applyable patches.
- **Ask the user:** the `ask_user` tool lets the agent pause for a CLI or desktop question panel with custom answers instead of guessing.
- **Output styles:** named `*.md` behavioral presets (the built-in `ELI5` style ships by default) change how responses are written without touching tool-use instructions.
- **Plugins and marketplaces:** `/plugin` adds marketplaces and installs plugins with autocomplete and instant reload, backed by a desktop Plugins tab.
- **Structured todos:** a built-in todo skill tracks task progress with an interactive, collapsible checklist card.
- **Lazy skill discovery:** most bundled skills are discoverable on demand via `skills.list()`/`skills.read()` instead of costing prompt tokens on every turn.
- **Bounded subagent trees:** root-tree RLM child count, concurrency, and optional cost limits, with session and global controls.

## Getting Started

Prometheus needs [Node.js](https://nodejs.org) 22.8 or newer. Install the CLI from npm on
macOS, Linux, or Windows:

```bash
npm install -g prometheus-agent
```

On macOS and Linux you can instead use the installer script, which sets up Node.js for you
if it is missing and can prepare the IPython runtime the agent uses:

```bash
curl -fsSL https://raw.githubusercontent.com/68flux-stack/Prometheus-Agent/main/install.sh | sh
```

Check the install:

```bash
prometheus --version
```

If `prometheus` isn't found, npm's global bin directory isn't on your `PATH`. Find it with
`npm bin -g` (or `npm config get prefix` and look in its `bin`/nothing-suffixed folder on
Windows) and add that to your shell's `PATH`.

Start Prometheus from the repository or directory you want it to work in:

```bash
cd /path/to/project
prometheus
```

On first launch, run `/login` to choose a subscription or API-key provider.

Update or remove it with npm:

```bash
npm install -g prometheus-agent@latest
npm uninstall -g prometheus-agent
```

## Desktop app

The desktop client is an Electron app backed by the same engine as the CLI. It bundles that
engine, so it needs no separate Node.js install.

Download an installer for your platform from the
[latest release](https://github.com/68flux-stack/Prometheus-Agent/releases/latest):

| Platform | File |
| --- | --- |
| Windows | `Prometheus-<version>-Setup.exe`, or `-Portable.exe` to run without installing |
| macOS | `Prometheus-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) |
| Linux | `Prometheus-<version>-x86_64.AppImage` or `Prometheus-<version>-amd64.deb` |

> [!NOTE]
> These builds are **not code-signed**. On Windows, SmartScreen shows an "unknown publisher"
> prompt: choose **More info → Run anyway**. On macOS, right-click the app and choose **Open**
> the first time, then confirm. Signing requires paid developer certificates.

Choose a workspace from the left sidebar to point the agent at another project. The desktop
client supports streaming prompts, aborting work, model and thinking-level selection, new
sessions, plugins, session statistics, and HTML export. Credentials and settings are shared
with the CLI.

To run the desktop app from a checkout instead:

```bash
npm install
npm run build
npm run desktop:dev
```

Prometheus works in the current directory and can run commands and modify files there. Use a
disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Prometheus executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
prometheus agents                   # Browse running, idle, and saved sessions
prometheus attach <agent>           # Reattach to a running session
prometheus --resume <path|id>       # Resume a saved session
prometheus status                   # Inspect background service state
prometheus doctor [--fix]           # Inspect or repair background services
prometheus update [--force]         # Update Prometheus
prometheus shutdown [--force]       # Stop every agent, worker, and background service
```

## Built for Long-Running Work
Prometheus is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously.

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, IPython state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `prometheus schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — persistent IPython, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source
- [Security policy](SECURITY.md) — how to report a vulnerability

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Prometheus is fully open source and released under the [MIT License](LICENSE).
