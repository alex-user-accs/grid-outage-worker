#!/bin/bash
# Runs the dashboard (web + worker) as macOS background services via launchd.
# They start at login and are restarted automatically if they crash.
#
#   npm run service:install     build + install + start
#   npm run service:restart     restart both (after code or .env changes: install again to rebuild)
#   npm run service:stop        stop both (they stay installed; start brings them back)
#   npm run service:start
#   npm run service:status
#   npm run service:logs
#   npm run service:uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFIX="${SERVICE_PREFIX:-com.deye-dashboard}"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/${SERVICE_PREFIX:-deye-dashboard}"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-3000}"
NAMES=(web worker)

die() { echo "✗ $*" >&2; exit 1; }
label() { echo "$PREFIX.$1"; }
plist() { echo "$AGENTS/$(label "$1").plist"; }

check_location() {
  case "$ROOT" in
    "$HOME/Desktop"* | "$HOME/Documents"* | "$HOME/Downloads"*)
      die "The project is in $ROOT. macOS blocks background services from reading Desktop, Documents and Downloads
  (they fail with 'Operation not permitted'). Move it first, e.g.:
    mv \"$ROOT\" \"$HOME/Projects/deye-cloud-app\"" ;;
  esac
}

write_plist() { # name, then program arguments
  local name="$1"; shift
  local args=""
  for a in "$@"; do args+="      <string>$a</string>"$'\n'; done
  cat >"$(plist "$name")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$(label "$name")</string>
    <key>ProgramArguments</key>
    <array>
$args    </array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>NODE_ENV</key><string>production</string>
      <key>PORT</key><string>$PORT</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOGS/$name.log</string>
    <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
  </dict>
</plist>
EOF
}

is_loaded() { launchctl print "$DOMAIN/$(label "$1")" >/dev/null 2>&1; }

start() {
  for n in "${NAMES[@]}"; do
    [ -f "$(plist "$n")" ] || die "not installed: run npm run service:install"
    is_loaded "$n" || launchctl bootstrap "$DOMAIN" "$(plist "$n")"
  done
  echo "✓ started"
}

stop() {
  for n in "${NAMES[@]}"; do is_loaded "$n" && launchctl bootout "$DOMAIN/$(label "$n")" || true; done
  echo "✓ stopped"
}

status() {
  for n in "${NAMES[@]}"; do
    if is_loaded "$n"; then
      local info pid state runs
      info="$(launchctl print "$DOMAIN/$(label "$n")")"
      state="$(awk -F'= ' '/^\tstate =/ {print $2; exit}' <<<"$info")"
      pid="$(awk -F'= ' '/^\tpid =/ {print $2; exit}' <<<"$info")"
      runs="$(awk -F'= ' '/^\truns =/ {print $2; exit}' <<<"$info")"
      printf "%-7s %-8s pid %-7s starts %s\n" "$n" "${state:-?}" "${pid:--}" "${runs:-?}"
    else
      printf "%-7s %s\n" "$n" "not running"
    fi
  done
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:$PORT/login" || true)"
  echo "web     http://localhost:$PORT/login -> HTTP ${code:-none}"
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -n "$ip" ] && echo "LAN     http://$ip:$PORT  (or http://$(scutil --get LocalHostName 2>/dev/null).local:$PORT)"
  pmset -g | grep -q "SleepDisabled[[:space:]]*1" \
    && echo "sleep   disabled (lid can be closed)" \
    || echo "sleep   ⚠ enabled: closing the lid will stop the server (sudo pmset -a disablesleep 1)"
}

case "${1:-}" in
  install)
    check_location
    NODE="$(command -v node)" || die "node not found in PATH"
    [ -f "$ROOT/.env" ] || die "$ROOT/.env is missing"
    if pgrep -f "$ROOT/node_modules/.bin/concurrently" >/dev/null; then
      die "npm run dev is running from this folder. Stop it (Ctrl+C) first: dev and service must not run together."
    fi
    mkdir -p "$AGENTS" "$LOGS"
    echo "→ building (npm run build)…"
    (cd "$ROOT" && npm run build --silent >/dev/null) || die "build failed: run npm run build to see why"
    stop >/dev/null
    write_plist web "$NODE" "$ROOT/node_modules/next/dist/bin/next" start -p "$PORT"
    write_plist worker "$NODE" --import tsx "$ROOT/src/worker/index.ts"
    start >/dev/null
    sleep 4
    echo "✓ installed: starts at login, restarts on crash. Logs: $LOGS"
    status
    ;;
  uninstall)
    stop >/dev/null
    for n in "${NAMES[@]}"; do rm -f "$(plist "$n")"; done
    echo "✓ removed (logs kept in $LOGS)"
    ;;
  start) start ;;
  stop) stop ;;
  restart)
    for n in "${NAMES[@]}"; do launchctl kickstart -k "$DOMAIN/$(label "$n")"; done
    echo "✓ restarted"
    ;;
  status) status ;;
  logs) tail -n 40 -F "$LOGS/web.log" "$LOGS/worker.log" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
