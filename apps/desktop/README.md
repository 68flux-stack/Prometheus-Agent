# Prometheus Desktop

This is a thin Electron client for Prometheus. The renderer talks to the coding-agent process through its JSONL RPC mode, so model providers, tools, session persistence, subagents, scheduling, and continual harness behavior stay in the shared runtime.

## Run from a checkout

From the repository root:

```bash
npm install
npm run build
npm run desktop:dev
```

`desktop:dev` rebuilds the shared coding-agent runtime first (via `predev` → `prepare-runtime.cjs`) if the source has changed since the last build, then opens the app pointed at the checkout's `packages/coding-agent/dist/bundle/cli.js`. This keeps the renderer, RPC process, and daemon protocol on the same version as your local changes.

The default workspace is the repository root. Use **Workspace** in the sidebar to choose a different project. Auth and session data are stored in Electron's user-data directory through `PROMETHEUS_CODING_AGENT_DIR`.

## Build an installer

```bash
npm run desktop:package -- --win     # or --mac / --linux
```

This stages a real copy of the published engine into `engine-staging/` (`scripts/stage-engine.mjs` packs `packages/coding-agent` and installs the tarball into a scratch prefix, so the packaged app carries its own `dist/bundle/cli.js` plus real native dependencies) and then runs `electron-builder` against `electron-builder.yml`. The packaged app needs no separate Node.js install — it runs the engine with Electron's own binary.

Builds are unsigned on every platform. Windows shows a SmartScreen "unknown publisher" prompt; macOS requires right-click → Open on first launch.

Installers land in `apps/desktop/dist/`.
