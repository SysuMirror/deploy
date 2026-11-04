# 构建阶段：Node 官方镜像 + 国内 npm 源
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_API_URL=
ARG VITE_BASE_PATH=/
ENV VITE_API_URL=$VITE_API_URL \
    VITE_BASE_PATH=$VITE_BASE_PATH

COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm ci

COPY . .
RUN npx vite build

# 运行阶段：现成 nginx 镜像，不再编译
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
