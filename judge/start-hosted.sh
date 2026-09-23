#!/bin/sh
set -eu

# A VM can receive concurrent wake requests from separate website functions.
# Only the command holding this lock owns its judge and its eventual shutdown.
exec 9>/run/corecode-judge.lock
flock -n 9 || exit 75
done_file="/run/corecode-${CORECODE_SESSION_ID}.done"
[ ! -f "$done_file" ] || exit 76
trap 'touch "$done_file"' EXIT

# Delegate a proper cgroup subtree before Docker creates worker groups. Sandbox
# starts its services at the root; memory limits need that root to be empty.
echo '-cpuset -cpu -pids' > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
mkdir -p /sys/fs/cgroup/corecode-host
limits_ready=0
for attempt in $(seq 1 30); do
  for pid in $(cat /sys/fs/cgroup/cgroup.procs); do
    echo "$pid" > /sys/fs/cgroup/corecode-host/cgroup.procs 2>/dev/null || true
  done
  echo '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  if grep -qw cpu /sys/fs/cgroup/cgroup.subtree_control &&
     grep -qw memory /sys/fs/cgroup/cgroup.subtree_control &&
     grep -qw pids /sys/fs/cgroup/cgroup.subtree_control; then
    limits_ready=1
    break
  fi
  sleep 0.1
done
[ "$limits_ready" = 1 ] || exit 1

if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  dockerd --host=unix:///var/run/docker.sock > /tmp/corecode-docker.log 2>&1 9>&- &
fi
ready=0
for attempt in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || exit 1

status=0
/opt/corecode/judge || status=$?
# Stop Docker before the filesystem snapshot. Learner containers have already
# been removed by the judge's normal drain/recovery path.
pkill -TERM -x dockerd || true
for attempt in $(seq 1 10); do
  pgrep -x dockerd >/dev/null || break
  sleep 1
done
exit "$status"
