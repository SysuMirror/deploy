#!/usr/bin/env bash
# sseinfra 一键部署入口（仓根必须可执行：chmod +x deploy.sh）
# 平台会注入：PORT、MINIO_*、MYSQL_*、REDIS_*（按组名匹配的凭证）
set -euo pipefail

PORT="${PORT:-8080}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "[deploy] PORT=$PORT ROOT=$ROOT"
echo "[deploy] MINIO_ENDPOINT=${MINIO_ENDPOINT:-} MINIO_BUCKET=${MINIO_BUCKET:-}"

# —— 示例：Node 后端 + 静态前端（按项目改）——
# 1) 安装依赖（有 package.json 才装）
if [ -f backend/package.json ]; then
  (cd backend && npm ci --omit=dev || npm install --omit=dev)
fi
if [ -f frontend/package.json ]; then
  (cd frontend && npm ci --omit=dev || npm install --omit=dev)
  # 若需构建静态资源：
  # (cd frontend && npm run build)
fi

# 2) 导出给应用进程
export PORT
export MINIO_ENDPOINT="${MINIO_ENDPOINT:-}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-}"
export MINIO_SECRET="${MINIO_SECRET:-}"
export MINIO_BUCKET="${MINIO_BUCKET:-}"
export MYSQL_HOST="${MYSQL_HOST:-}"
export MYSQL_PORT="${MYSQL_PORT:-3306}"
export MYSQL_USER="${MYSQL_USER:-}"
export MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
export MYSQL_DB="${MYSQL_DB:-}"

# 3) 前台常驻（supervisord 托管本脚本，勿后台化后退出）
# 务必监听 0.0.0.0，否则公网 :23xxx 不可达
if [ -f backend/server.js ]; then
  exec node backend/server.js
elif [ -f backend/dist/index.js ]; then
  exec node backend/dist/index.js
elif [ -f backend/main.py ]; then
  exec python3 backend/main.py
else
  echo "[deploy] 未找到启动入口，请改本脚本指向你的服务" >&2
  # 占位：避免立刻退出导致 supervisord FATAL（联调时可换成真实命令）
  exec python3 - <<PY
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
port = int(os.environ.get("PORT", "8080"))
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok deploy.sh placeholder; replace with your app\\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
print(f"[deploy] placeholder listening 0.0.0.0:{port}", flush=True)
HTTPServer(("0.0.0.0", port), H).serve_forever()
PY
fi
