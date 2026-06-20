# Lessons from this codebase

This is the distilled version of decisions that took longer than they should have. Read it before adding a new layer of indirection.

## Design principles (set by the user, treat as fixed)

1. **One thing at a time.** Sync blocking is the default. Don't reach for async/detached/backgrounded unless the use case truly demands it. The agent should be able to reason about one tool call → one answer.
2. **Multi-process > multi-model.** Don't build a single process that switches between models — the user has explicitly said this gets too complex and unstable. If you need a different model, spawn a separate opencode (the `opencode websocket` bridge) and talk to it.
3. **Default to the simpler option.** The repo has a history of over-engineering sync → async, in-process → cross-process. The new layer usually costs more than it saves.

## Pain points we've hit (don't repeat them)

### The `ws_client` tool got too clever

- **What we did**: `detached: true` originally `Bun.spawn`'d an inline `bun run -e` worker. Wrote the result to a file. Agent polls the file.
- **Why it hurt**: Polling is the worst of both worlds. The agent doesn't know when the job is done, and proactive polling burns turns.
- **Fix**: replaced with `BackgroundJob.start({ run: Effect<string, unknown> })`. The job runs in the parent process, output is in `info.output`, agent uses `ws_client({ taskId })` to wait. The result file is still written for external observers but is no longer the primary channel.
- **Lesson**: when async work is in-process, use the in-process job system. Don't shell out.

### The bridge's per-WS-client session state was a footgun

- **What we did**: sessions were stored in `ClientState` keyed by WS client. Each new WS connection got a fresh `Map<string, ClientSession>()`.
- **Why it hurt**: the persisted session ID was useless across reconnects, because the new client's `ClientState` didn't have it. `switch_session` returned `session_not_found`.
- **Fix**: `switch_session` now falls back to `client.session.get({ path: { id } })` on the opencode SDK. If the server has the session, we adopt it. Persistence then works.
- **Lesson**: the wrong layer of state scope can silently break the design above. Test the design *across* layer boundaries, not just within them.

### `task` vs `ws_client` got conflated

- **What we did**: built the bridge + keep-alive + persistence + detached mode for "send a prompt to a sub-agent" — which is what `task` already does, in-process, in 3 seconds.
- **Why it hurt**: 8–10 minute round-trips, 800 MB resident processes, all to do what `task` does for free.
- **Fix**: documented when to use which (see `subagent-decision-tree.md`). The bridge is for *peers*, not for "I want a sub-agent".
- **Lesson**: when adding a new tool, ask "what is this *not* for?" as carefully as "what is it for?".

### `OPENCODE_DEFAULT_MODEL` doesn't work

- **What we did**: tried to set the model for the bridge via the env var `OPENCODE_DEFAULT_MODEL`.
- **Why it hurt**: opencode doesn't read that var. The model is set in `opencode.jsonc` (`model` and `small_model` fields). The env var was silently ignored.
- **Fix**: bridge has its own `opencode.jsonc` in `/tmp/sub-agent-keepalive/opencode.jsonc` that pins the model.
- **Lesson**: when an env var is "supposed to work", verify by reading the config-loading code. `grep "OPENCODE_DEFAULT_MODEL" src/config/` is faster than guessing.

### `opencode run` is non-interactive but slow with the wrong model

- **What we did**: tested the new tool via `opencode run --model omlx/Qwen3.6-27B ...`. The local 27B model takes 2–3 min per LLM turn.
- **Why it hurt**: 15 min timeout, single LLM call, still didn't finish. 10× over budget.
- **Fix**: for tests, use the cloud model (`minimax-cn/MiniMax-M3`). For real work, use `task` to delegate to the sub-agent (in-process, fast).
- **Lesson**: when iterating on tool behavior, test via `task` (which uses the cloud model by default) rather than `opencode run` (which uses whatever the local config says).

### The "small_model" agent can 404

- **What we did**: the bridge was running with `model: omlx/Qwen3.6-27B-UD-MLX-4bit` and `small_model: omlx/Qwen3.6-27B-UD-MLX-4bit`. The title-generation agent and other "small" jobs hit the model just fine.
- **What almost went wrong**: a different `small_model` in the config (`omlx/Qwen3.6-35B-A3B-...-Opus-Reasoning-Distilled-MLX-oQ4-MTP`) doesn't exist on the server. Title generation 404s, session errors out.
- **Fix**: always make sure `small_model` is set to a model the server actually has. Test by triggering a title generation.
- **Lesson**: when something "should work" but doesn't, check the model the *small* agent is using, not just the main one.

## Patterns that worked

- **Effect.promise + Effect.gen**: the right way to do Promise-returning code in Effect land. Don't try to make Bun's APIs return Effects directly.
- **The keep-alive script is idempotent**: `ws-spawn-keepalive.ts` checks for a live process and reuses it. Running it twice doesn't leak. This is a good pattern for any "ensure a long-running thing is up" — check first, spawn only if needed.
- **Result files for external observers, BackgroundJob for the agent**: dual-write (job has the canonical output, file is the side-channel). Cheap, works for both consumers.
- **Schema-first tool params**: `Schema.Struct(...)` with `.annotate({ description })`. The LLM sees a clean JSON Schema; we get validation for free.
- **Server-side fallback in protocol handlers**: `switch_session` doesn't trust the client state — it asks the server. If a state mismatch is possible, verify with the source of truth.
