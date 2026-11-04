ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app

# better-sqlite3 编译依赖 + 压缩包→K8s 跳板所需（sshpass/scp/ssh/tar）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
      openssh-client sshpass tar git \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY}

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=3002
# 不在镜像内落库：生产必须由 compose 覆盖为宿主机绝对路径（见 docker-compose.yml）
# ENV DEPLOY_DATA_DIR 故意不设默认 /app/data，避免 rebuild 丢数据

EXPOSE 3002

# 原 docker-entrypoint.sh 内联到此处（不再单独脚本）：
# 数据目录必须是宿主机绝对路径，否则 rebuild 会丢库/丢包；目录创建与 modules.conf 兜底一并完成。
ENTRYPOINT ["/bin/sh", "-c", "set -e; \
  DATA_DIR=\"${DEPLOY_DATA_DIR:-}\"; \
  HOST_ROOT=\"${SDPY_HOST_DATA:-}\"; \
  if [ -z \"$DATA_DIR\" ]; then echo '[sdpy-api] ERROR: DEPLOY_DATA_DIR 未设置' >&2; exit 1; fi; \
  case \"$DATA_DIR\" in /app|/app/*|./data|./data/*|data|data/*) echo '[sdpy-api] ERROR: DEPLOY_DATA_DIR 落在镜像内，rebuild 会丢数据' >&2; exit 1;; esac; \
  case \"$DATA_DIR\" in /*) ;; *) echo '[sdpy-api] ERROR: DEPLOY_DATA_DIR 必须是绝对路径' >&2; exit 1;; esac; \
  if [ -n \"$HOST_ROOT\" ]; then \
    case \"$HOST_ROOT\" in /*) ;; *) echo '[sdpy-api] ERROR: SDPY_HOST_DATA 必须是绝对路径' >&2; exit 1;; esac; \
    if [ ! -d \"$HOST_ROOT\" ]; then echo '[sdpy-api] ERROR: 宿主机数据根未挂载' >&2; exit 1; fi; \
  fi; \
  mkdir -p \"$DATA_DIR/uploads\" \"$DATA_DIR/work\" \"$DATA_DIR/nginx\"; \
  MODULE_ROOT=\"${MODULE_DATA_ROOT:-/root/SSE_Market/sse-sdpy/data}\"; \
  mkdir -p \"$MODULE_ROOT\"; \
  if [ ! -f \"$DATA_DIR/nginx/modules.conf\" ]; then echo '# SSE Deploy modules — awaiting first deploy' > \"$DATA_DIR/nginx/modules.conf\"; fi; \
  exec node dist/index.js"]
