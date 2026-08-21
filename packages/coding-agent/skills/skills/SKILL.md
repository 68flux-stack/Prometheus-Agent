---
name: skills
description: List installed skills that are not already described in context, and read one on demand. Use to discover a capability you were not told about upfront, before assuming it does not exist.
---

# Skills

Most installed skills are not shown to you by default to save context — only
their existence is implied by this skill. Use it to browse and load them on
demand instead of assuming a capability is unavailable.

```python
await skills.list()
await skills.list(query="frontend")
await skills.read("impeccable")
```

## API

- `await skills.list(query=None)` — every installed skill not already visible
  elsewhere in your context: `name`, `kind` (`"markdown"` or `"python"`),
  `description`, and `python_import` when applicable. Optional `query` does a
  case-insensitive substring match over name and description.
- `await skills.read(name)` — the full `SKILL.md` body for one skill, the same
  content `/skill:name` would load. Works for any installed skill, not only
  ones returned by `list()`.

## When to use this

Call `list()` when a task might be covered by a specialized skill you have
not been told about — a niche domain, a file format, a creative technique, an
external product. Call `read(name)` once a candidate looks relevant, then
follow its instructions.

Do not call `list()` for a capability already documented directly in your
base prompt (`websearch`, `compact`, `goal`, `todo`, `edit`, `attach_image`,
`agent_observe`, `agent_message`, `rlm_heartbeat`) — those are already fully
usable as described, with no lookup needed first. Reach for `list()` only
when the task needs something none of those primitives cover.
