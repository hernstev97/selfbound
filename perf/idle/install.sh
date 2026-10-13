#!/bin/sh
# Optional: installs the idle measurement as a systemd user timer (Linux; perf/README.md).
# The timer starts `perf/idle.ts run` every 30 minutes; a pass measures only within the time window
# (default 01:00–08:00), with no game running, a quiet GPU and low load.
# It always measures origin/main in a separate worktree (~/.cache/xlr8-perf/main); your own
# worktree stays untouched.
#
# Usage:   perf/idle/install.sh            install and start
#          perf/idle/install.sh --remove   remove the timer (state in ~/.local/state/xlr8-perf stays)
set -eu
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
units="$HOME/.config/systemd/user"
work="$HOME/.cache/xlr8-perf/main"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now xlr8-perf-idle.timer 2>/dev/null || true
  rm -f "$units/xlr8-perf-idle.timer" "$units/xlr8-perf-idle.service"
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
cat > "$units/xlr8-perf-idle.service" <<UNIT
[Unit]
Description=XLR8: idle performance measurement (perf/idle.ts)

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
cat > "$units/xlr8-perf-idle.timer" <<UNIT
[Unit]
Description=XLR8: check every 30 minutes whether a measurement can run

[Timer]
OnCalendar=*:00/30
RandomizedDelaySec=120
Persistent=false

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now xlr8-perf-idle.timer
echo "Installed. Status: node perf/idle.ts status · log: ~/.local/state/xlr8-perf/idle.log"
