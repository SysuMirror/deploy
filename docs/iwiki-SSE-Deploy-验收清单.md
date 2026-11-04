> **版本**：v1.0  
> **状态**：内测验收用  
> **源稿**：仓库 `docs/验收清单.md`

---

## A. 本地控制台

- [ ] `npm run dev:api` → `/api/health` 返回 ok  
- [ ] `npm run dev:web` 可打开  
- [ ] OAuth 可登录（配置真实 `OAUTH_*`）  

## B. 模块与上传

- [ ] 创建项目、注册模块名（保留字被拒绝）  
- [ ] 上传 zip：含 `frontend/`、`backend/`、`compose.yml`  
- [ ] 示例：`deploy/examples/sample-app/`  
- [ ] 模块详情展示测试/正式前端与后端路径（含 `-api`）  

## C. 部署（需 Docker）

- [ ] 「部署测试」成功后，宿主机可访问分配端口  
- [ ] `data/nginx/modules.conf` 出现对应 location  
- [ ] upstream 为 `host.docker.internal`（Docker nginx 场景）  
- [ ] 「部署正式」不停止测试容器  
- [ ] 可选 `--no-cache`  

## D. 生产路径

- [ ] 公共 nginx 已 include snippet（无逐模块手写 location）  
- [ ] 管理站可登录  
- [ ] 管理台链接访问前端/后端非 502  
- [ ] 用户前端构建使用 `SDPY_API_PUBLIC_URL`  

## E. 回归注意

- [ ] 模块端口为 `0.0.0.0:81xx`，非 `127.0.0.1`  
- [ ] reload 使用真实 nginx **容器名**  

---

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 从仓库验收清单同步并去掉公网 URL 列表 |
