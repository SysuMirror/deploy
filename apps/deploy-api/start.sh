#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p data/nginx data/work data/uploads
test -f data/nginx/modules.conf || echo "# awaiting first deploy" > data/nginx/modules.conf

# 永久写入 .env（仅当未配置或为空时）
HOST_DATA="$(pwd)"
if [ ! -f .env ]; then
  echo "缺少 .env" >&2
  exit 1
fi
if grep -qE '^SDPY_HOST_DATA=$' .env || ! grep -qE '^SDPY_HOST_DATA=' .env; then
  if grep -qE '^SDPY_HOST_DATA=' .env; then
    sed -i.bak "s|^SDPY_HOST_DATA=.*|SDPY_HOST_DATA=${HOST_DATA}|" .env
  else
    printf '\nSDPY_HOST_DATA=%s\n' "${HOST_DATA}" >> .env
  fi
  echo "已写入 .env: SDPY_HOST_DATA=${HOST_DATA}"
else
  echo "使用 .env 中的 SDPY_HOST_DATA=$(grep -E '^SDPY_HOST_DATA=' .env | cut -d= -f2-)"
fi

docker compose up -d --build
echo "API health: http://127.0.0.1:3002/api/health"
