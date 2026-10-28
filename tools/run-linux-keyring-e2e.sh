#!/usr/bin/env bash
# Linux 真实 Secret Service E2E：在独立 D-Bus 会话中解锁临时 gnome-keyring，再跑 Electron。
set -euo pipefail
eval "$(printf '%s' 'agenthub-e2e-keyring-password' | gnome-keyring-daemon --unlock --components=secrets)"
exec xvfb-run -a npm run e2e:secure-storage
