#!/bin/sh
# Optional: installs the idle measurement as a systemd user timer (Linux; perf/README.md).
# The timer starts `perf/idle.ts run` every 30 minutes; a pass measures only within the time window
# (default 01:00–08:00), with no game running, a quiet GPU and low load.
# It always measures origin/main in a separate worktree (~/.cache/selfbound-perf/main); your own
# worktree stays untouched.
#
# Usage:   perf/idle/install.sh            install and start; replaces the units of the old name
#          perf/idle/install.sh --remove   remove the timer (state in ~/.local/state/selfbound-perf stays)
# legacy-xlr8: the units used to be called xlr8-perf-idle.*; install and --remove clean them up too.
set -eu
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
cache="${XDG_CACHE_HOME:-$HOME/.cache}"
# Same rule as tooling/lib/env.mjs: the old cache folder is used only while it is the only one.
# legacy-xlr8: ~/.cache/xlr8-perf
if [ -d "$cache/selfbound-perf" ] || [ ! -d "$cache/xlr8-perf" ]; then
  work="$cache/selfbound-perf/main"
else
  # legacy-xlr8: old cache folder
  work="$cache/xlr8-perf/main"
  echo "Note: using the old folder $cache/xlr8-perf (move it to $cache/selfbound-perf to drop the old name)."
fi

# legacy-xlr8: units of the old name
remove_old_units() {
  for unit in xlr8-perf-idle.timer xlr8-perf-idle.service; do  # legacy-xlr8
    if [ -e "$units/$unit" ]; then
      case "$unit" in *.timer) systemctl --user disable --now "$unit" 2>/dev/null || true ;; esac
      rm -f "$units/$unit"
      echo "Removed old unit $unit"
    fi
  done
}

if [ "${1:-}" = "--remove" ]; then
  remove_old_units
  systemctl --user disable --now selfbound-perf-idle.timer 2>/dev/null || true
  rm -f "$units/selfbound-perf-idle.timer" "$units/selfbound-perf-idle.service"
  systemctl --user daemon-reload
  echo "Timer removed."
  exit 0
fi

if [ ! -d "$work/.git" ] && [ ! -f "$work/.git" ]; then
  mkdir -p "$(dirname "$work")"
  git -C "$repo" fetch -q origin main
  git -C "$repo" worktree add --detach "$work" origin/main
fi
node_bin=$(command -v node)
mkdir -p "$units"
# Stop the old timer before the new one starts, so a pass cannot run twice.
remove_old_units
cat > "$units/selfbound-perf-idle.service" <<UNIT
[Unit]
Description=Selfbound: idle performance measurement (perf/idle.ts)

[Service]
Type=oneshot
WorkingDirectory=$work
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin
# Always run main, never a worktree with half-finished changes.
ExecStartPre=/usr/bin/git fetch -q origin main
ExecStartPre=/usr/bin/git checkout -q --detach origin/main
ExecStart=$node_bin perf/idle.ts run
TimeoutStartSec=4h
UNIT
cat > "$units/selfbound-perf-idle.timer" <<UNIT
[Unit]
Description=Selfbound: check every 30 minutes whether a measurement can run

[Timer]
OnCalendar=*:00/30
RandomizedDelaySec=120
Persistent=false

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now selfbound-perf-idle.timer
echo "Installed selfbound-perf-idle.timer. Status: node perf/idle.ts status · log: ${XDG_STATE_HOME:-$HOME/.local/state}/selfbound-perf/idle.log"
