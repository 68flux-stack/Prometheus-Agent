---
name: todo
description: Display a progress checklist in the UI.
---

# Todo

```python
import todo

# Set checklist
await todo.set("Task Title", ["Step 1", "Step 2", "Step 3"])

# Update step status ("in_progress" | "done" | "pending")
await todo.update(1, "in_progress")
await todo.update(1, "done")
```
