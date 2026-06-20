# Subagent decision tree

There are four ways to delegate work to another agent. Picking the wrong one costs you either performance (subprocess overhead) or correctness (lost context). Read this before adding a new delegation path.

## The four options

```
                  in-process                            cross-process
                  ─────────                            ─────────────
fire-and-forget   task({ background: true })            ws_client({ detached: true })
wait for result   task({ })                             ws_client({ })
read-only         explore({ })                          (use in-process — bridge has no read-only mode)
```

- **`task`** — in-process subagent, runs in the parent's Effect runtime, shares cwd/files/permission. The output is the agent's final text. Add `background: true` (with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`) to start the task and continue; the result is auto-injected on completion.
- **`explore`** — in-process subagent, read-only (can't mutate, can't write files, can't run arbitrary bash). Use for "look at this codebase and tell me X".
- **`ws_client`** — cross-process. Sends a prompt to a *separate* opencode running on `opencode websocket`. The peer has its own cwd, its own model, its own permission rules.

## Which one to pick

Start with these questions in order:

1. **Is this work read-only?**
   - Yes → `explore`. Cannot mutate, cannot make expensive side effects.
   - No → continue.

2. **Can the subagent use the same cwd, the same model, the same permission rules as me?**
   - Yes → `task`. In-process is always cheaper.
   - No → continue.

3. **Does the subagent need to survive across many of my turns? (e.g., it's a long-running peer I keep coming back to)**
   - Yes → `ws_client` with the keep-alive bridge. See `cheatsheet.md` for the lifecycle.
   - No → continue.

4. **Do I need the subagent to use a different model than me?**
   - Yes → `ws_client` with a bridge that has the other model configured.
   - No → `task`. (Even for "I want a different model", check if you can just `/model` instead.)

5. **None of the above** — `ws_client`. You need a peer, you've ruled out the cheaper options, and you're paying the cost intentionally.

## Anti-patterns we have a history of

- **Spawning a `opencode websocket` subprocess to "send one prompt"**. This is `task`. The bridge is for peers, not for one-shot delegation. If you find yourself writing `bun run scripts/ws-ask.ts "..."` from a script, stop and use `task` instead.
- **Polling a result file for a backgrounded job**. Use `BackgroundJob.wait({ id, timeout })`. Files are for external observers (humans, scripts in another process), not for the agent that started the work.
- **Conflating "subagent" and "peer process"**. They are different. Subagent is a *capability*; peer process is an *isolation boundary*. The bridge gives you the latter; `task` gives you the former.
- **Multi-model architecture in a single process**. Don't. The user has been explicit: cross-process > multi-model. If you need a different model, spawn a separate opencode (bridge) and talk to it.

## Concrete examples

| Task | Tool | Why |
|---|---|---|
| "Look at this codebase and tell me where X is defined" | `explore` | Read-only, fast, in-process |
| "Run a research task and bring back findings" | `task` | One-shot, in-process, shares model |
| "I need to talk to a different opencode that's been running for hours with its own session" | `ws_client` | Cross-process, long-lived, isolated |
| "Run a long task in the background and keep working" | `task({ background: true })` | In-process background, cheaper than cross-process |
| "Use a different model (e.g., a local MLX) for this one thing" | `ws_client` with a bridge configured for that model | Cross-process, model switch |
| "Have a subagent do X while I do Y" | Two `task` calls in parallel, OR `task({ background: true })` for X | Both in-process, no bridge needed |

## When `ws_client` is the right answer

- The peer has been running for a long time and you want to query it again later.
- The peer has a state you need to *read* but not own (a long-running experiment, a watched log, etc).
- You need to send work to a remote opencode on a different machine.
- You specifically need model isolation because the peer has a different default model.

## Quick API for `ws_client`

```ts
// Sync: wait for the answer
ws_client({ prompt: "..." })
// Optional: sessionId, timeout, autoStart

// Detached: fire-and-forget, returns taskId
ws_client({ prompt: "...", detached: true })
//   → { taskId, resultFile }

// Fetch the result of a detached task
ws_client({ taskId, timeout: 60 })
//   → text on completion
//   → "still running" message on timeout (call again)
```

The keep-alive bridge state lives in `/tmp/sub-agent-keepalive/state.json`. The script `scripts/ws-spawn-keepalive.ts` is idempotent — running it twice does not leak processes.
