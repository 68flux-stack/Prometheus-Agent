# Prometheus Desktop

This is a thin Electron client for Prometheus. The renderer talks to the existing coding-agent process through its JSONL RPC mode, so model providers, tools, session persistence, subagents, scheduling, and continual harness behavior stay in the upstream runtime.

From the repository root:

```bash
npm install
npm run desktop:dev
```

The desktop command builds the shared Prometheus runtime before opening the app. This keeps the renderer, RPC process, and daemon protocol on the same version after local changes.

The default workspace is the repository root. Use **Workspace** in the sidebar to choose a different project. Auth and session data are stored in Electron's user-data directory through `PROMETHEUS_CODING_AGENT_DIR`.

For a packaged build, set `PROMETHEUS_CLI_PATH` to the bundled `packages/coding-agent/dist/cli.js` path or update `electron/main.cjs` to point at the packaged runtime.

## Windows application identity

Use the packaged Windows build when you want Task Manager to show Prometheus instead of Electron:

```bash
npm run desktop:package:win
```

The generated installer and portable executable use the Prometheus name, executable identity, and logo. The development command runs inside Electron's `electron.exe`, so Windows Task Manager will necessarily label that process Electron.
