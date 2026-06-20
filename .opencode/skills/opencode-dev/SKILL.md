---
name: opencode-dev
description: When working on the opencode monorepo (packages/opencode, packages/core, packages/llm, packages/effect-drizzle-sqlite), apply our architectural conventions, subagent patterns, and Effect v4 idioms. Triggers: adding CLI commands or tools, modifying the websocket bridge, designing subagent delegation, touching Session/Instance/Skill systems, refactoring an existing tool, or reviewing a change before commit.
---

# opencode development

The repo is a monorepo: each package in `packages/*` is independently versioned and built, but the live CLI is `packages/opencode`. `bun typecheck` from a package dir is the contract; tests live next to source in `test/`.

## How to use this skill

1. **First decision: which package owns the change?** If the answer is unclear, look at the existing file's package — don't move code across packages casually. `packages/opencode` is the CLI/server/TUI; `packages/core` is shared schemas and the BackgroundJob engine; `packages/llm` is provider-agnostic LLM plumbing.
2. **Find the closest existing example** before writing the new one. The repo is full of templates: a CLI command has a template (`src/cli/cmd/<name>/`), a tool has a template (`src/tool/<name>.{ts,txt}`), a service has a template (`src/<name>/<name>.ts` with `export * as X from "."`).
3. **Effect v4 first**. The repo dropped Effect v3 patterns. If a snippet in memory or in a blog post uses `Effect.tryPromise` or `pipe(...).pipe(...)` chains, it's stale — search `.opencode/references/effect-smol` or existing repo code.
4. **Run `bun typecheck` from the package** before committing. Tests run from package dirs too (`packages/opencode` for CLI/tool tests, never from repo root).

## Skill files

- `architecture.md` — subagent system, websocket bridge, tool/tool-runtime split. **Read this first** if the task touches any of those.
- `effect-conventions.md` — the Effect v4 patterns we use: `Effect.fn`, `Effect.gen`, `Schema.Struct`, `Tool.define`, `Layer.effect`, `InstanceState.make`, `BackgroundJob`. Required reading for any new service or tool.
- `subagent-decision-tree.md` — when to use `task` (in-process), `explore` (read-only in-process), vs. `ws_client` bridge (cross-process). Most subagent work is `task`. The bridge is for cross-process persistence/isolation, not "I want a sub-agent".
- `lessons.md` — design principles and pain points. Read this before adding a new layer of indirection; the repo has a history of over-engineering sync → async, in-process → cross-process. Default to the simpler option.
- `cheatsheet.md` — quick reference: rebuild binary, run smoke tests, file paths, env vars, the keep-alive bridge lifecycle.

## When NOT to use this skill

- Pure user-code questions unrelated to the opencode codebase.
- General Effect v4 questions that aren't tied to this repo's idioms — use the `effect` skill for that.
- The opencode binary in the user's `$PATH` is not a place to make changes; the source is in `packages/opencode`. If you're asked to "fix opencode" while a session is running, that's a request to edit source and rebuild.
