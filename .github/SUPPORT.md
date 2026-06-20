# Getting Support

Thanks for using OpenCode! Here's how to get help, in order of how fast you
should expect a response.

## Before you ask

1. **Search the docs.** Most setup and configuration questions are
   covered at [opencode.ai/docs](https://opencode.ai/docs).
2. **Search existing issues.** Someone may have already reported the same
   thing at [github.com/anomalyco/opencode/issues](https://github.com/anomalyco/opencode/issues).
3. **Check the FAQ / troubleshooting.** Many common problems (provider
   auth, model not found, server unreachable) have a one-line fix.

## Channels

Pick the channel that matches what you need. Posting in the wrong place
is the single biggest reason new contributors get a slow response.

### 💬 Discord — quick questions, real-time chat

Best for: "how do I…", "does this work with…", general usage.

👉 https://discord.gg/opencode

Discord is fast but conversations get lost. Anything important should end
up on GitHub so it benefits the next person.

### 🐛 GitHub Issues — bugs, reproducible problems

Best for: a specific bug, a stack trace, a reproducible failure, a
feature request with a clear shape.

👉 https://github.com/anomalyco/opencode/issues/new/choose

Please use one of the issue templates. Issues without a template get
auto-closed. See [CONTRIBUTING.md](./CONTRIBUTING.md#issue-requirements).

### 🔒 Security — vulnerabilities only

**Do not file a public issue for security problems.** Email
security@opencode.ai instead. See [SECURITY.md](./SECURITY.md) for our
threat model and disclosure policy.

> We do not accept AI-generated security reports — see
> [SECURITY.md](./SECURITY.md) for the policy.

### 💼 Commercial / enterprise

For commercial support, SLAs, custom integrations, or anything that
needs an NDA: enterprise@opencode.ai.

## What to include

Whatever channel you pick, the people helping you can do it a lot faster
if you include:

- `opencode --version` and which platform (macOS arm64 / Linux x64 / etc.)
- The provider + model you're using (e.g. `anthropic/claude-opus-4-6`)
- What you ran, what you expected, what happened
- A copy of the relevant log line from `~/.local/share/opencode/log/`
  (redact any tokens / API keys first)
- If it's a UI bug: a screenshot or screen recording

A useful template:

> **What I ran:**
> `opencode telegram --token $TG_BOT_TOKEN`
>
> **What I expected:**
> the bot to start a session
>
> **What happened:**
> nothing; log says `ECONNREFUSED 127.0.0.1:4096`
>
> **Versions:**
> opencode 1.0.3, macOS arm64

The more concrete, the better.

## What we *won't* do

- We won't accept AI-generated security reports. Email only.
- We won't help with commercial / non-public deployments in public
  channels — those go to enterprise@opencode.ai.
- We won't reopen closed issues without a new reproduction. If your
  problem is the same as a closed one, leave a comment on the closed
  issue with what changed on your end.
