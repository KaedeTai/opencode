# Opencode Telegram Integration

Telegram bot built into the [opencode](https://opencode.ai) CLI — see
the [repo root README](./README.md) and [LICENSE](./LICENSE). Runs the
opencode server in-process and connects a Telegraf bot to it, so any chat
can drive an opencode session over messaging.

Want to extend the bot or fix a bug? See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for the rules of the road.

## Usage

```bash
# Required: bot token from @BotFather
export TELEGRAM_BOT_TOKEN='your-bot-token'
# Optional: comma-separated chat IDs. Empty = allow any chat.
export TELEGRAM_ALLOWED_USERS='123456789,987654321'

opencode telegram
# or
opencode tg --token 'xxx' --allowed-users '123,456'
```

## Files

```
packages/opencode/src/cli/cmd/telegram/
  index.ts     TelegramCommand + stateful handlers
  config.ts    Model catalog (server-backed), config read/write,
               stopgap getSessionTokens (DB-direct; see TODO there)
  whisper.ts   Voice transcription (whisper.cpp + ffmpeg pre-decode)
  paths.ts     DB path + sessions file + config dir resolution
  log.ts       Log helper for non-Effect contexts
  format.ts    Text truncation
```

## Bot commands

| command              | what it does                                                  |
|----------------------|---------------------------------------------------------------|
| `/start`             | welcome + command list                                        |
| `/new`               | create a new session (becomes active; old one archived)       |
| `/abort`             | stop the current turn                                         |
| `/status`            | session id (N/M if multi), model, state, tokens + context     |
| `/share`             | get a shareable link                                          |
| `/model`             | show inline picker or `/model <query>` to switch              |
| `/compact`           | summarize the current session                                 |
| `/fork`              | fork at the last user message                                 |
| `/retry`             | resend the last user prompt                                   |
| `/sessions`          | list this chat's sessions, tap to switch / new                |
| `/to <id> <message>` | route a prompt to a specific session in this chat             |
| `/whoami`            | show your chat id                                             |
| `/help`              | help                                                          |

Any other message is sent as a prompt to the active session. If no
session exists, one is created automatically.

## Multi-session

Each chat can hold multiple sessions. `/new` archives the current
active session and starts a new one (the old one stays in the chat
and can be re-activated via `/sessions`). All sessions in a chat can
be in-flight in parallel — busy guard is per-session, not per-chat.

The `chat-id → { active, sessions: { sid: state }, order }` map is
persisted to `~/.local/share/opencode/telegram-sessions.json` (debounced
500ms). The old single-session format is auto-migrated on load.

## Media

- **Photo** — downloaded, base64'd, sent as `{type:"file", mime:"image/jpeg", url:<data URI>, filename}` so vision-capable models see the image. 6MB cap.
- **Voice / audio** — decoded to 16kHz mono PCM via ffmpeg, then transcribed by local whisper.cpp (`WHISPER_BIN`, `WHISPER_MODEL` env vars). 120s cap. The transcribed text is sent as a normal prompt with a `[voice]` marker.
- **Document** — downloaded, sent as a file part. 20MB cap.

## Streaming

The assistant text stream is rendered in place via `editMessageText`
with a 1.5s throttle (Telegram caps edits at ~20/min on the same
message). Reasoning, tool completions, and patch summaries each
open a new message so they don't fight the streaming edit for the
same handle.

## Event stream

The bot subscribes to `client.event.subscribe()` (SSE) and reconnects
with exponential backoff (1s → 2s → 4s → … capped at 60s, ±30% jitter)
on disconnect.

## Concurrency

`SessionState.inflight` is set when `promptAsync` is dispatched and
cleared by the `session.status: idle` event. A second prompt arriving
mid-turn is held by a `Promise` (`infllightWait`) until the server
acknowledges the abort, or 5s, whichever comes first.

## Persistence

The chat-id → `{ active, sessions, order }` map is persisted to
`~/.local/share/opencode/telegram-sessions.json` (debounced 500ms).
Older single-session files are auto-migrated to the new shape on load.

## Environment variables

| variable                 | CLI option        | required | notes                                          |
|--------------------------|-------------------|----------|------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`     | `--token`         | yes      | one of env / flag must be set                  |
| `TELEGRAM_ALLOWED_USERS` | `--allowed-users` | no       | comma-separated chat IDs; empty = allow all    |
| `WHISPER_BIN`            | —                 | no       | defaults to `/opt/homebrew/bin/whisper-cli`    |
| `WHISPER_MODEL`          | —                 | no       | defaults to `~/models/whisper/ggml-large-v3-turbo.bin` |
| `OPENCODE_DEFAULT_MODEL` | —                 | no       | `providerID/modelID`; overrides config         |
| `OPENCODE_DEFAULT_PROVIDER` | —              | no       | used when default model lacks provider prefix  |
| `OPENCODE_CONFIG_DIR`    | —                 | no       | for `/model` config reads/writes               |
| `OPENCODE_PRINT_LOGS`    | `--print-logs`    | no       | set to `1` to mirror bot logs to stderr        |
| `OPENCODE_LOG_LEVEL`     | `--log-level`     | no       | `DEBUG` / `INFO` / `WARN` / `ERROR`            |

## Limitations

- Long-polling only. Webhook mode is not yet supported.
- No reply context (the bot ignores the message being replied to).
- Image-part MIME detection on the model side depends on the model's
  vision capabilities.
