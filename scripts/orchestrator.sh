#!/usr/bin/env bash
# Thin wrapper around the Node orchestrator daemon. Subcommands:
#   start      — launch the daemon in the foreground (Ctrl-C to stop)
#   start-bg   — launch the daemon in the background; PID is written to
#                .orchestrator/orchestrator.pid and stdout+stderr to
#                .orchestrator/orchestrator.log
#   stop       — send SIGTERM (graceful: waits for the in-flight plan to
#                finish; can take hours)
#   force-stop — SIGTERM, wait briefly, then SIGKILL — for an unresponsive
#                daemon or when the in-flight plan must be abandoned
#   status     — curl the control server's /status endpoint
#
# Port is configurable via ORCHESTRATOR_PORT (default 4500).
# Graceful-stop poll cap (in seconds) configurable via
# ORCHESTRATOR_STOP_TIMEOUT_S (default 6 hours — a graceful stop must wait
# for the in-flight plan to finish).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${ORCHESTRATOR_PORT:-4500}"
STATE_DIR="$ROOT/.orchestrator"
PID_FILE="$STATE_DIR/orchestrator.pid"
LOG_FILE="$STATE_DIR/orchestrator.log"
# Default 6h. Graceful /stop must wait for the active plan to finish — long
# claude jobs can run for hours. Operators that need a hard cancel use
# `force-stop` instead.
STOP_TIMEOUT_S="${ORCHESTRATOR_STOP_TIMEOUT_S:-21600}"
FORCE_STOP_GRACE_S="${ORCHESTRATOR_FORCE_STOP_GRACE_S:-15}"

mkdir -p "$STATE_DIR"

cmd="${1:-}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./scripts/orchestrator.sh <command> [args]

Commands:
  start            Launch the orchestrator in the foreground (Ctrl-C to stop).
  start-bg         Launch the orchestrator in the background; PID is tracked.
  stop             Graceful: SIGTERM and wait for the in-flight plan to finish
                   (up to ORCHESTRATOR_STOP_TIMEOUT_S, default 6h).
  force-stop       SIGTERM, wait briefly, then SIGKILL. Abandons the in-flight
                   plan; on next boot the daemon recovers via run_task_loop.sh.
  status           curl the control server's /status endpoint.
  freeze [reason]  POST /freeze — halts all runs cleanly (plan 0052).
  unfreeze         POST /unfreeze — clears the halt.
  budget raise <n> Raise the per-product token ceiling to <n> (plan 0052).
                   Edits .orchestrator/budget.json in place; restart not
                   required.
EOF
}

case "$cmd" in
  start)
    command -v node >/dev/null 2>&1 || die "node is required"
    exec env ORCHESTRATOR_PORT="$PORT" \
      node --experimental-strip-types apps/orchestrator/src/index.ts
    ;;
  start-bg)
    command -v node >/dev/null 2>&1 || die "node is required"
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE")"
      if kill -0 "$pid" 2>/dev/null; then
        die "orchestrator already running (pid $pid)"
      fi
      rm -f "$PID_FILE"
    fi
    nohup env ORCHESTRATOR_PORT="$PORT" \
      node --experimental-strip-types apps/orchestrator/src/index.ts \
      >>"$LOG_FILE" 2>&1 &
    pid=$!
    echo "$pid" >"$PID_FILE"
    echo "Started orchestrator (pid $pid). Log: $LOG_FILE"
    ;;
  stop)
    [[ -f "$PID_FILE" ]] || die "no pid file at $PID_FILE"
    pid="$(cat "$PID_FILE")"
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "orchestrator not running (stale pid $pid); removing pid file"
      rm -f "$PID_FILE"
      exit 0
    fi
    kill -TERM "$pid"
    echo "Sent SIGTERM to orchestrator (pid $pid). /stop is graceful: waiting"
    echo "up to ${STOP_TIMEOUT_S}s for the in-flight plan to finish (heartbeat every 60s)."
    waited=0
    while (( waited < STOP_TIMEOUT_S )) && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$(( waited + 1 ))
      if (( waited % 60 == 0 )); then
        echo "  ... still waiting (${waited}s elapsed). Tail $LOG_FILE for activity."
      fi
    done
    if kill -0 "$pid" 2>/dev/null; then
      die "orchestrator (pid $pid) did not exit within ${STOP_TIMEOUT_S}s. Inspect $LOG_FILE; rerun with 'force-stop' to abandon the in-flight plan."
    fi
    rm -f "$PID_FILE"
    echo "Stopped orchestrator (pid $pid)."
    ;;
  force-stop)
    [[ -f "$PID_FILE" ]] || die "no pid file at $PID_FILE"
    pid="$(cat "$PID_FILE")"
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "orchestrator not running (stale pid $pid); removing pid file"
      rm -f "$PID_FILE"
      exit 0
    fi
    kill -TERM "$pid"
    echo "Sent SIGTERM to orchestrator (pid $pid); SIGKILL in ${FORCE_STOP_GRACE_S}s if still alive."
    waited=0
    while (( waited < FORCE_STOP_GRACE_S )) && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$(( waited + 1 ))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" || true
      echo "Sent SIGKILL to orchestrator (pid $pid). On next boot, the in-flight plan will be recovered via run_task_loop.sh."
    fi
    rm -f "$PID_FILE"
    echo "Force-stopped orchestrator (pid $pid)."
    ;;
  status)
    command -v curl >/dev/null 2>&1 || die "curl is required"
    curl -fsS "http://127.0.0.1:${PORT}/status"
    echo ""
    ;;
  freeze)
    command -v curl >/dev/null 2>&1 || die "curl is required"
    shift || true
    reason="${*:-}"
    if [[ -n "$reason" ]]; then
      # Pack spaces into `+` so the server's querystring parser decodes them.
      encoded="${reason// /+}"
      curl -fsS -X POST "http://127.0.0.1:${PORT}/freeze?reason=${encoded}"
    else
      curl -fsS -X POST "http://127.0.0.1:${PORT}/freeze"
    fi
    echo ""
    ;;
  unfreeze)
    command -v curl >/dev/null 2>&1 || die "curl is required"
    curl -fsS -X POST "http://127.0.0.1:${PORT}/unfreeze"
    echo ""
    ;;
  budget)
    sub="${2:-}"
    case "$sub" in
      raise)
        new_ceiling="${3:-}"
        [[ -n "$new_ceiling" ]] || die "usage: orchestrator.sh budget raise <n>"
        [[ "$new_ceiling" =~ ^[0-9]+$ ]] || die "ceiling must be a positive integer"
        node --experimental-strip-types \
          "$ROOT/scripts/budget-raise.mjs" "$new_ceiling" "$STATE_DIR"
        ;;
      ""|"-h"|"--help")
        cat <<'EOF'
Usage: ./scripts/orchestrator.sh budget <subcommand>

Subcommands:
  raise <n>   Raise the per-product token ceiling to <n>.
EOF
        ;;
      *)
        die "unknown budget subcommand: $sub"
        ;;
    esac
    ;;
  ""|"-h"|"--help"|"help")
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
