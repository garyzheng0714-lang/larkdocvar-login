#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  echo "[dev-up] node_modules 不存在，自动执行 npm install ..."
  npm install
fi

if [[ ! -f .env && -f .env.example ]]; then
  echo "[dev-up] 未检测到 .env，自动从 .env.example 复制"
  cp .env.example .env
fi

echo "[dev-up] 启动前后端开发服务..."
exec npm run dev:raw
