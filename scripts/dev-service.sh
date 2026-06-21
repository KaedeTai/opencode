#!/usr/bin/env bash
# Install / uninstall the opencode dev LaunchAgent.
#
# Usage:
#   scripts/dev-service.sh install     # install + start
#   scripts/dev-service.sh uninstall   # stop + remove
#   scripts/dev-service.sh restart     # trigger restart (no rebuild)
#   scripts/dev-service.sh status      # show launchctl info + logs

set -euo pipefail

PLIST_SRC="$HOME/opencode/scripts/launchd/com.opencode.dev.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.opencode.dev.plist"
LABEL="com.opencode.dev"
GUI_TARGET="gui/$(id -u)"

case "${1:-}" in
  install)
    if [ ! -f "$PLIST_SRC" ]; then
      echo "error: plist not found at $PLIST_SRC" >&2
      exit 1
    fi
    cp "$PLIST_SRC" "$PLIST_DST"
    echo "[install] copied plist to $PLIST_DST"
    # bootstrap (idempotent — bootout first if already loaded)
    launchctl bootout "$GUI_TARGET/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$GUI_TARGET" "$PLIST_DST"
    echo "[install] bootstrapped $LABEL in $GUI_TARGET"
    echo "[install] logs: tail -f /tmp/opencode-dev.log /tmp/opencode-dev.err"
    ;;
  uninstall)
    launchctl bootout "$GUI_TARGET/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "[uninstall] removed $LABEL"
    ;;
  restart)
    # -k: kill (SIGTERM, then SIGKILL) and restart
    launchctl kickstart -k "$GUI_TARGET/$LABEL"
    echo "[restart] kicked $LABEL"
    ;;
  status)
    launchctl print "$GUI_TARGET/$LABEL" 2>&1 | head -30 || echo "not loaded"
    echo ""
    echo "--- recent stdout ---"
    tail -20 /tmp/opencode-dev.log 2>/dev/null || echo "(no log)"
    echo ""
    echo "--- recent stderr ---"
    tail -20 /tmp/opencode-dev.err 2>/dev/null || echo "(no err)"
    ;;
  *)
    echo "usage: $0 {install|uninstall|restart|status}" >&2
    exit 2
    ;;
esac
