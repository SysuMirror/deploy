# PowerShell：构建 sdpy 发布包（api + web/sdpy + web-deploy）
# 用法：powershell -ExecutionPolicy Bypass -File deploy/pack-release.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '>> build ui + api + web (/sdpy/) + web-deploy (/)'
npm run build:ui
npm run build:api
npm run build:web
npm run build:web-deploy

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $root "dist-packages/sdpy-$stamp"
$apiSrc = Join-Path $root 'apps/deploy-api'
$webSrc = Join-Path $root 'apps/deploy-web/dist'
$webDeploySrc = Join-Path $root 'apps/deploy-web/dist-deploy'

New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'api') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'web') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'web-deploy') | Out-Null

Copy-Item -Recurse -Force (Join-Path $apiSrc 'dist') (Join-Path $outDir 'api/dist')
foreach ($f in @('package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.env.production')) {
  $p = Join-Path $apiSrc $f
  if (Test-Path $p) { Copy-Item -Force $p (Join-Path $outDir "api/$f") }
}
Copy-Item -Recurse -Force "$webSrc/*" (Join-Path $outDir 'web')
Copy-Item -Recurse -Force "$webDeploySrc/*" (Join-Path $outDir 'web-deploy')

@'
# 部署说明

覆盖 api/ → /root/SSE_Market/sse-sdpy/api/（或 /opt/release-sdpy/api/）
覆盖 web/ → .../web/（/sdpy/ 路径入口）
覆盖 web-deploy/ → .../web-deploy/（https://deploy.ssemarket.cn/）

## OAuth（同 app_id 双入口）
docker exec -i sse_market_db mysql -uroot -padmin ssemarket < deploy/oauth/credentials/register-oauth-apps.sql

## nginx
- 主站 /sdpy/：已有 snippet deploy/nginx-ssemarket-sdpy.conf.snippet
- 子域 deploy.ssemarket.cn：deploy/nginx-ssemarket-deploy.conf.snippet

cd /root/SSE_Market/sse-sdpy/api && docker compose up -d --build
docker exec sse_market_server-nginx_proxy-1 nginx -t && docker exec sse_market_server-nginx_proxy-1 nginx -s reload
'@ | Set-Content -Encoding UTF8 (Join-Path $outDir 'DEPLOY.txt')

Write-Host ">> done: $outDir"
