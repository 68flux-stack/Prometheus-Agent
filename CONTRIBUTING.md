# Contributing

Thanks for helping improve Prometheus.

## Before you start

Read [`AGENTS.md`](AGENTS.md) in the repository root. It is the binding guide for
contribution, testing, protocol, changelog, dependency, and Git rules, and it takes
precedence over this file.

## Setup

Node.js 22.8 or newer is required.

```bash
npm install
npm run build
```

## Making a change

1. Branch from `main`.
2. Make the change, keeping the diff scoped to the task.
3. Run `npm run check` from the repository root and review the full output. It formats,
   lints, typechecks, and runs the installer and browser smoke checks. It does not run tests.
4. If you added or changed a test file, run that exact file from its package root with the
   Vitest command documented in `AGENTS.md`, and iterate until it passes.
5. Add a one-line, past-tense bullet under `## [Unreleased]` in the affected package's
   `CHANGELOG.md`. Do not edit released sections.
6. Stage only the files your change touches. Do not use `git add -A` or `git add .`.

## Pull requests

Describe what changed and why, and say how you verified it. CI runs the build, checks, and
the test matrix on every pull request.

## Releasing (maintainers)

Releases are triggered by pushing a `v*` tag:

```bash
npm run release:patch   # or release:minor / release:major
```

That bumps versions, rolls the changelogs, commits, tags, and pushes. The tag push starts
[`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes
`prometheus-agent` to npm, builds the desktop installers for Windows, macOS, and Linux, and
creates the GitHub Release. Nothing is published from a developer machine.

Requires the `NPM_TOKEN` repository secret.
