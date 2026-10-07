#!/usr/bin/env bash
# R2 视频站 —— 一键安装 / 更新（macOS / Linux）
# 用法：./install.sh [--yes] [--reset-password]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没有找到 Node.js（需要 22 或更高版本）。"
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "  可以运行：brew install node"
  else
    echo "  请到 https://nodejs.org 下载安装最新 LTS 版本，装好后重新运行 ./install.sh"
  fi
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "✗ Node.js 版本太旧（当前 $(node -v)，需要 22 或更高）。请到 https://nodejs.org 升级。"
  exit 1
fi

exec node scripts/install.mjs "$@"
