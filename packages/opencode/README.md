# opencode

The CLI entry point for [OpenCode](https://opencode.ai). This is the
package that builds into the `opencode` binary users run from a
terminal.

It owns:

- The yargs-based CLI (`src/index.ts`)
- The `Effect.fn`-driven command handlers (`src/cli/cmd/`)
- The headless HTTP server (`src/server/`)
- The session / prompt / event V2 runtime (`src/session/`)
- The agent / provider / tool registries (`src/agent/`, `src/provider/`, `src/tool/`)

## Install

You usually don't install this package directly. Instead install the
`opencode-ai` binary:

```bash
# Recommended: platform installer
curl -fsSL https://opencode.ai/install | bash

# Or via a package manager
brew install anomalyco/tap/opencode
npm i -g opencode-ai@latest
```

## Develop

From the repo root, not this directory — the package is part of a
workspace:

```bash
git clone https://github.com/anomalyco/opencode
cd opencode
bun install
bun dev           # TUI by default; see CONTRIBUTING.md for the other entrypoints
```

`bun dev` is the local equivalent of the built `opencode` command. To
run a different subcommand:

```bash
bun dev telegram   # Telegram bot
bun dev web        # browser UI
bun dev serve      # headless server
bun dev --help     # full list
```

## Build

```bash
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-<platform>/bin/opencode --version
```

## Tests

```bash
bun test               # all tests
bun typecheck          # tsgo --noEmit
```

`AGENTS.md` in this directory has the package-specific style guide and
conventions. The repo-root `AGENTS.md` and `CONTRIBUTING.md` cover the
shared bits (branch names, commit style, PR process).

## License

MIT — see [LICENSE](../../LICENSE).
