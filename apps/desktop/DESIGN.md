# Prometheus Desktop Design

## Visual direction

The desktop client uses a calm, dense, Claude Code-style workbench: dark charcoal surfaces, hairline dividers, flat depth, and a single warm apricot action color. It should feel like a tool that stays open beside the code, not a dashboard competing with it.

## Color roles

- `#1b1b1b` — main work surface
- `#151515` — project rail
- `#202020` / `#292929` — controls and raised transcript elements
- `#343434` — dividers and quiet borders
- `#f0efed` — primary text
- `#9b9b9b` — secondary text
- `#e98262` — Prometheus action and active state

## Composition

- A 276px left rail keeps project, session, and utility actions persistent.
- The main header is compact and contextual: project, separator, session name, model, and thinking level.
- The empty state is inline and task-led; it avoids a large hero card.
- Conversation content is centered to an 860px reading measure.
- The composer is always anchored to the bottom with a flat, focused input surface.
- Advanced session controls open in a temporary right-side runtime drawer. Execution permissions, background jobs, and isolated patches stay discoverable without permanently narrowing the transcript.

## Component language

Use 5–8px radii, 1px borders, small shadows only where they separate the composer, and inline SVG icons with a consistent 1.3–1.5px stroke. Avoid gradients, decorative glows, oversized labels, and icon tiles. Motion is limited to short transcript insertion and the active status pulse.

## Responsive behavior

Runtime rows use compact status text, progress bars only when a command reports progress, and explicit action labels. Destructive patch discard and unrestricted execution require confirmation; routine refreshes remain non-modal.

At narrower desktop widths, the rail remains usable, the header controls compress, and the transcript keeps a readable measure. The composer and message rows may use the full available width while preserving the same spacing and border language.
