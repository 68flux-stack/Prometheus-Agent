# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Electron with a vanilla HTML/CSS/JavaScript renderer, backed by Prometheus's existing JSONL RPC runtime.

## Users

Developers and technical researchers using Prometheus for repository work, investigation, and long-running agent sessions.

## Product Purpose

Give Prometheus a focused desktop workspace for choosing a project, starting sessions, sending prompts, watching tool work, and returning to durable sessions without leaving the agent runtime.

## Positioning

The desktop surface is a native client for the real Prometheus engine, so the same tools, model providers, sessions, subagents, and harness state remain available instead of being reimplemented in the renderer.

## Operating Context

The user works in a project directory and keeps the desktop client open while the agent reads files, runs commands, and streams progress. Credentials and session data remain local to the desktop runtime.

## Capabilities and Constraints

The desktop client must preserve RPC streaming, workspace switching, model and thinking-level controls, session creation, abort, statistics, and HTML export. Prometheus commands execute with the user's permissions and are not a security sandbox.

## Brand Commitments

The user requested a Claude Code-like desktop experience: calm, dark, dense, utility-first, and centered on the work. Use a warm apricot accent for Prometheus actions without copying another product's marks or proprietary assets.

## Product Principles

- Keep the agent's work in focus.
- Make project and session state visible without ceremony.
- Prefer native, direct controls over decorative chrome.
- Preserve the CLI engine's depth behind a calmer surface.
