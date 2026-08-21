# Quickstart

This page gets you from install to a useful first Prometheus session.

## Install

Prometheus needs Node.js 22.8 or newer. Install it from npm on Linux, macOS, or Windows:

```bash
npm install -g prometheus-agent
```

On Linux and macOS the installer script can set up Node.js for you if it is missing, and
prepare the IPython runtime the agent uses:

```bash
curl -fsSL https://raw.githubusercontent.com/68flux-stack/Prometheus-Agent/main/install.sh | sh
```

Both install the `prometheus` command. The inherited npm workspace identifiers in the source tree are not the public install path.

Then start Prometheus in the project directory you want it to work on:

```bash
cd /path/to/project
prometheus
```

To run a source checkout instead, use Node.js 22.8.0 or newer:

```bash
git clone https://github.com/PrometheusIntellect-ai/prometheus
cd prometheus
npm ci
./prometheus.sh
```

The source runner preserves the directory from which it is invoked, so you can also call `/path/to/prometheus/prometheus.sh` from another project.

## Authenticate

Prometheus can use subscription providers through `/login`, or API-key providers through environment variables or its auth file.

### Option 1: Subscription Login

Start Prometheus and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API Key

Set an API key before launching Prometheus:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prometheus
```

You can also run `/login` and select an API-key provider to store the key in `~/.prometheus/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First Session

Once Prometheus starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

Prometheus gives the model one built-in tool, `ipython`. The long-lived kernel is a control environment for reading and editing files, running project commands, inspecting data, retaining Python state, and invoking installed skills. The kernel runtime is bootstrapped automatically on first use; set `PROMETHEUS_KERNEL_PYTHON` to use an existing Python environment with `ipykernel`.

Prometheus runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Recursive Subagents

Recursive subagents are a built-in Prometheus capability. The model spawns independent work from IPython with `await rlm("subtask")`; each call returns at admission with a child handle and never returns the answer. A child's final response is relayed to the parent automatically; explicit `agent_message` calls remain available for progress updates and intermediate findings. Child agents use the same TypeScript agent runtime, providers, tools, skills, and session machinery as the parent.

You can prompt the model to use that capability directly:

```text
Review authentication and test coverage as independent subtasks. Run them in parallel, then synthesize the findings.
```

See [RLM Runtime Architecture](rlm-runtime.md) for the API and execution model.

## Give Prometheus Project Instructions

Prometheus loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Prometheus loads:

- `~/.prometheus/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Prometheus, or run `/reload`, after changing context files.

## Common Things to Try

### Reference Files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
prometheus @README.md "Summarize this"
prometheus @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run Shell Commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to model context. During agent work, the model normally runs project commands from the IPython control environment with a `%%bash` cell.

### Switch Models

Use `/model` or Ctrl+L to choose a model. Use `/effort` to set the reasoning level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Sessions are saved automatically under `~/.prometheus/agent/sessions/`:

```bash
prometheus -c                  # Continue the most recent session
prometheus -r [path|id]        # Browse sessions or open a specific session
```

Inside Prometheus, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. Persistent sessions run in worker processes, so closing the TUI detaches from the agent rather than necessarily stopping it. Use `prometheus agents` to inspect or reattach to active work.

### Non-Interactive Mode

For one-shot prompts:

```bash
prometheus -p "Summarize this codebase"
cat README.md | prometheus -p "Summarize this text"
prometheus -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next Steps

- [Using Prometheus](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Prometheus Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
