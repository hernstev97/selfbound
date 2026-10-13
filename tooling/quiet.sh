#!/bin/sh
# Runs a command with limited load, so the machine stays usable while builds and tests run:
# only the given CPU cores, lowest CPU and disk priority, capped memory, limited run time.
# For builds and tests during development, not for performance runs (those need an idle
# machine, see perf/README.md "When to measure").
#
# Usage:       tooling/quiet.sh pnpm test
#              tooling/quiet.sh pnpm e2e
# Environment: XLR8_QUIET_CPUS (default: the upper half of the cores), XLR8_QUIET_MINUTES (default 30),
#              XLR8_QUIET_MEM (default 12G). The old names XLR8_LEISE_* still work.
#
# With systemd (user scope): AllowedCPUs, CPUWeight and IOWeight 10, MemoryHigh.
# Without systemd: taskset, nice 19, ionice idle.
set -eu
n=$(nproc 2>/dev/null || echo 2)
half="$((n / 2))-$((n - 1))"
[ "$n" -gt 1 ] || half=0
cpus=${XLR8_QUIET_CPUS:-${XLR8_LEISE_CPUS:-$half}}
minutes=${XLR8_QUIET_MINUTES:-${XLR8_LEISE_MINUTES:-30}}
mem=${XLR8_QUIET_MEM:-${XLR8_LEISE_MEM:-12G}}
[ "$#" -gt 0 ] || { echo "usage: tooling/quiet.sh <command> [arguments …]" >&2; exit 2; }
if command -v systemd-run >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ]; then
  exec systemd-run --user --scope --quiet --collect \
    -p AllowedCPUs="$cpus" -p CPUWeight=10 -p IOWeight=10 -p MemoryHigh="$mem" \
    -- timeout --kill-after=30s "${minutes}m" nice -n 19 ionice -c 3 "$@"
fi
exec timeout --kill-after=30s "${minutes}m" taskset -c "$cpus" nice -n 19 ionice -c 3 "$@"
