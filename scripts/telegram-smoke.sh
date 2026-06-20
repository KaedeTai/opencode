#!/bin/bash
# Telegram bot smoke test.
#
# Verifies that a running opencode telegram bot is alive and that the
# integrated HTTP API surface is responding correctly. This is a
# "is the integration up" check, not a full unit-test sweep — it runs
# alongside `bun test`, not instead of it.
#
# Run from the repo root:
#   ./scripts/telegram-smoke.sh
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed
#   2 = the opencode server isn't running on :4096
#
# The script does NOT start or kill the bot. It assumes `start-telegram-bot.sh`
# already has one running on 127.0.0.1:4096 (default).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/packages/opencode"
SERVER_URL="${OPENCODE_SERVER_URL:-http://127.0.0.1:4096}"
PASS=0
FAIL=0

# Color helpers (no color when stdout is not a TTY)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  NC=''
fi

log()   { echo -e "$1"; }
pass()  { log "${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail()  { log "${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
warn()  { log "${YELLOW}!${NC} $1"; }
header(){ log "\n${YELLOW}== $1 ==${NC}"; }

# ── 0. Sanity: am I in the right repo? ─────────────────────────────────────
if [[ ! -d "$PACKAGE_DIR" ]]; then
  fail "packages/opencode not found at $PACKAGE_DIR — run from repo root or update PACKAGE_DIR"
  exit 1
fi

# ── 1. Server reachability ─────────────────────────────────────────────────
header "1. Server reachability ($SERVER_URL)"
if ! curl -sf -m 3 "$SERVER_URL/global/health" >/dev/null 2>&1; then
  fail "Server not responding on $SERVER_URL — start it with: ~/.local/bin/start-telegram-bot.sh"
  exit 2
fi

HEALTH_JSON="$(curl -sf -m 5 "$SERVER_URL/global/health")"
HEALTHY="$(echo "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('healthy', False))" 2>/dev/null)"
VERSION="$(echo "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version', '?'))" 2>/dev/null)"

if [[ "$HEALTHY" == "True" || "$HEALTHY" == "true" ]]; then
  pass "Server healthy (version: $VERSION)"
else
  fail "Server /global/health did not report healthy=true. Got: $HEALTH_JSON"
fi

# ── 2. Bot process is alive ────────────────────────────────────────────────
header "2. Bot process"
if pgrep -fl "opencode" | grep -q "telegram"; then
  BOT_PID="$(pgrep -fl "opencode" | grep "telegram" | awk '{print $1}' | head -1)"
  pass "Bot process running (PID $BOT_PID)"
else
  fail "No opencode telegram process found. Start with: ~/.local/bin/start-telegram-bot.sh"
fi

# ── 3. API surface: session create + question list ─────────────────────────
header "3. API surface"

# Create a fresh session — confirms POST /session works end-to-end.
SESSION_JSON="$(curl -sf -m 5 -X POST "$SERVER_URL/session" \
  -H "Content-Type: application/json" \
  -d '{"title":"smoke-test"}')"
SESSION_ID="$(echo "$SESSION_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)"

if [[ -n "$SESSION_ID" && "$SESSION_ID" == ses_* ]]; then
  pass "POST /session returned valid session id ($SESSION_ID)"
else
  fail "POST /session did not return a session id. Got: $(echo "$SESSION_JSON" | head -c 200)"
fi

# List pending questions — confirms GET /question route exists.
QUESTION_STATUS="$(curl -sf -m 5 -o /dev/null -w "%{http_code}" "$SERVER_URL/question")"
if [[ "$QUESTION_STATUS" == "200" ]]; then
  pass "GET /question route reachable (HTTP 200)"
else
  fail "GET /question returned HTTP $QUESTION_STATUS (expected 200)"
fi

# Reject a fake question id — confirms POST /question/:id/reject validation works
# without requiring a real question flow.
REJECT_STATUS="$(curl -sf -m 5 -o /dev/null -w "%{http_code}" -X POST \
  "$SERVER_URL/question/que_smoke_fake_id_xxxxx/reject" 2>&1)"
if [[ "$REJECT_STATUS" =~ ^(200|400|404)$ ]]; then
  pass "POST /question/:id/reject responds (HTTP $REJECT_STATUS — 200/400/404 all OK)"
else
  fail "POST /question/:id/reject returned unexpected HTTP $REJECT_STATUS"
fi

# ── 4. Telegram question reply shape (the bug we just fixed) ───────────────
# Server schema: answers = string[][]. Send a fake reply to a non-existent
# question and verify the error mentions QuestionAnswer, NOT 'string'. If
# the server had regressed to expecting string[], this would pass
# silently; instead the 400 is expected.
header "4. Question reply payload shape"
REPLY_STATUS="$(curl -s -m 5 -o /tmp/smoke-reply.json -w "%{http_code}" -X POST \
  "$SERVER_URL/question/que_smoke_fake_id_xxxxx/reply" \
  -H "Content-Type: application/json" \
  -d '{"answers":[["option-a"]]}')"
REPLY_BODY="$(cat /tmp/smoke-reply.json 2>/dev/null)"

if [[ "$REPLY_STATUS" == "400" || "$REPLY_STATUS" == "404" ]]; then
  # The 400 is expected for a fake id; what matters is the payload validation
  # accepts our shape (it would 400 with 'Expected QuestionAnswer' if we sent
  # the wrong shape, 400/404 for a missing id is fine).
  if echo "$REPLY_BODY" | grep -q "Expected QuestionAnswer, got"; then
    fail "Server rejected our string[][] payload shape: $REPLY_BODY"
  else
    pass "Server accepted string[][] payload shape (HTTP $REPLY_STATUS for fake id)"
  fi
else
  warn "POST /question/:id/reply returned HTTP $REPLY_STATUS (expected 400/404)"
fi

# ── 5. Unit tests (the defensive parsing layer) ────────────────────────────
header "5. Unit tests"
if command -v bun >/dev/null 2>&1; then
  if (cd "$PACKAGE_DIR" && bun test test/cli/cmd/telegram.test.ts 2>&1 | tail -3) ; then
    pass "telegram.test.ts unit tests passed"
  else
    fail "telegram.test.ts unit tests failed — run manually: cd packages/opencode && bun test test/cli/cmd/telegram.test.ts"
  fi
else
  warn "bun not in PATH; skipping unit tests"
fi

# ── Summary ────────────────────────────────────────────────────────────────
header "Summary"
TOTAL=$((PASS+FAIL))
log "${GREEN}Passed: $PASS${NC} / $TOTAL"
if [[ "$FAIL" -gt 0 ]]; then
  log "${RED}Failed: $FAIL${NC}"
  exit 1
fi
log "${GREEN}All smoke checks passed.${NC}"
exit 0
