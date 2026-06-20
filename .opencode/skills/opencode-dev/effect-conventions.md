# Effect v4 conventions in this repo

Effect v4 (effect-smol) only. v3 patterns are stale; if you see `pipe(...).pipe(...)` or `Effect.tryPromise` in a snippet, it's not from this codebase.

## Effect.gen for composition

```ts
Effect.gen(function* () {
  const svc = yield* Service.Service
  const result = yield* svc.doThing(input)
  return result
})
```

- `function*` is required — yield* is how you compose. Don't try to chain `.flatMap` manually.
- `yield* Effect.promise(() => somePromise)` for Promise-returning code.
- `yield* Effect.tryPromise({ try, catch: (e) => new MyError(...) })` if you need to convert errors to a typed effect error.
- `yield* Effect.fail(new MyError(...))` to short-circuit with a typed error.

## Tool.define pattern

Every tool is structured the same way:

```ts
export const MyTool = Tool.define(
  "my_tool",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service  // any service you need
    return {
      description: DESCRIPTION,                      // from .txt file
      parameters: Parameters,                        // Schema.Struct
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "my_tool", patterns: [...], always: [...] })
          const result = yield* Effect.promise(() => doWork(params))
          yield* ctx.metadata({ metadata: { ... } })
          return { title: "...", output: "...", metadata: { ... } }
        }).pipe(Effect.orDie),
    }
  }),
)
```

- `Effect.orDie` at the end — let typed errors resolve to a tool error, untyped errors crash the tool (visible in the UI).
- `ctx.ask` for any non-default permission. Default-allow is *not* a thing — every tool with side effects asks.
- `ctx.metadata` lets you update the tool's UI metadata after the call.

## Schema for params

```ts
const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description: "What this param is, with examples.",
  }),
  count: Schema.optional(Schema.Number).annotate({
    description: "Must be > 0.",
  }),
  flags: Schema.optional(Schema.Array(Schema.String)),
})
```

- `Schema.optional(...)` for optional fields. Don't use `Schema.String` and then check for undefined in the body — let the schema do it.
- `.annotate({ description: "..." })` — the description shows up in the JSON Schema the LLM sees. Be terse, give defaults, give examples.
- For union types: `Schema.Union(Schema.Literal("a"), Schema.Literal("b"))`. For branded IDs: `Schema.brand`.
- For typed errors: `Schema.TaggedErrorClass` (see migration.md).

## Service + Layer

```ts
// src/foo/foo.ts
export interface Interface { doThing: (input: Foo) => Effect.Effect<Bar, FooError> }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, /* make */)
export const defaultLayer = layer.pipe(/* env, defaults, etc */)

export * as Foo from "./foo"
```

- Single file, single namespace. Consumers do `import { Foo } from "@/foo/foo"` and yield `Foo.Service`.
- For per-instance state (each opencode project has its own): `InstanceState.make(() => Foo.make)` from `src/effect/instance-state.ts`. Auto-cleanup on instance dispose.
- For background fibers (event subscriptions, etc): `Effect.forkIn(scope, { startImmediately: true })` inside the `InstanceState.make` closure. The fiber is interrupted when the instance is disposed.
- `Effect.cached` for dedup-ing concurrent calls (don't write `let fiber: Fiber | undefined` by hand).

## BackgroundJob for async work

`BackgroundJob.start({ id?, type, title, metadata, run, onPromote? })` returns a job ID immediately. `run: Effect.Effect<string, unknown>` is the unit of work; the string is what gets stored as the job's `output`. The runtime owns cancellation, scope, and the `info` snapshot.

Use it whenever a tool might block on I/O for longer than a few seconds and the agent shouldn't have to wait. The classic case is the `ws_client` tool's `detached: true` mode — the Effect runs in the parent process, the agent fetches the result later via `ws_client({ taskId })`.

Don't `Bun.spawn` a worker subprocess for in-process work — it bypasses the job system, leaks state, and you lose the ability to wait/cancel/list from the agent.

## What NOT to do

- `await` inside `Effect.gen` — yields are how you compose, `await` is for Promises. Wrap a Promise in `Effect.promise` or `Effect.tryPromise`.
- `any` — there are typed alternatives for everything we do.
- `try`/`catch` in Effect code — model the error as a `Schema.TaggedErrorClass` and `yield* Effect.fail(new MyError(...))`.
- `Effect.fork` / `Effect.forkDaemon` — these don't exist in v4. Use `Effect.forkIn(scope, { startImmediately: true })`.
- Process-global state outside `InstanceState` — two opencode instances in different cwds will collide.
