# Opencode Plugins

This directory contains custom plugins for Opencode.

## agents-context.ts

**Purpose**: Automatically injects AGENTS.md context when reading files.

**How it works**:

- When you read any file, the plugin walks up the directory tree to the workspace root
- It collects all `AGENTS.md` files along the way (from most specific to workspace root)
- Only injects each `AGENTS.md` once per session
- Appends content wrapped in `<system_message>` tags to the tool output

**Example**:

```
# You read: apps/api/src/routes/auth.ts

# Plugin automatically includes:
- apps/api/src/routes/AGENTS.md (if exists)
- apps/api/src/AGENTS.md (if exists)
- apps/api/AGENTS.md (if exists)
- apps/AGENTS.md (if exists)
- AGENTS.md (workspace root, if exists)
```

**Benefits**:

- Subdirectory-specific context is automatically provided
- No need to manually read AGENTS.md files
- Context is only added once per session to avoid duplication
- LLM receives hierarchical context from specific → general

## sound-notifications.ts

**Purpose**: Provides audio feedback for agent events.

**How it works**:

- Plays a bell sound when permission is requested
- Plays a bell sound when the agent finishes (session idle)
