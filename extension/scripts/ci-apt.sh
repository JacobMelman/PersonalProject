#!/usr/bin/env bash
# Installs Ubuntu packages on a GitHub runner without the occasional stall: once `apt-get update` hung for 40 minutes on a mirror
# and the job was cancelled. Every network call is bounded, a stalled attempt is retried, and man-db is not rebuilt.
set -u
sudo rm -f /var/lib/man-db/auto-update
opts=(-q -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)
for attempt in 1 2 3; do
  sudo dpkg --configure -a >/dev/null 2>&1 || true
  if sudo timeout 240 apt-get "${opts[@]}" update &&
     sudo DEBIAN_FRONTEND=noninteractive timeout 600 apt-get "${opts[@]}" install -y --no-install-recommends "$@"; then
    exit 0
  fi
  echo "::warning::apt attempt $attempt failed or timed out; retrying"
  sleep 15
done
echo "::error::could not install: $*"
exit 1
