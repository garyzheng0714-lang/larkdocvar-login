# 飞书边栏插件：云文档变量替换生成器

支持从模板文档提取 `{{变量}}`，按多维表格字段自动绑定并批量生成文档，最后回写生成链接。

## 快速上手（先看这个）

新手建议直接按下面 4 步走，一次就能跑通：

1. 登录插件（右上角显示你的账号即成功）。
2. 粘贴模板文档链接，点击“提取变量”。
3. 检查“变量映射”是否正确（字段越多越建议用搜索）。
4. 点击“全部生成”或“生成选中项”，系统会自动回写文档链接到表格。

补充说明（最容易困惑的两点）：

- 文档所有权和默认权限已固定为自动策略，不需要手动配置。
- 生成流程建议始终按“提取变量 -> 检查映射 -> 开始生成”顺序，避免漏填。

## 本地开发（尽量少动手）

1. 首次配置环境变量

```bash
cp .env.example .env
```

2. 在 `.env` 填写飞书应用凭证

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
PORT=3000
```

3. 启动（会自动检测依赖，缺失时自动执行 `npm install`）

```bash
npm run dev
```

默认地址：
- 前端运行地址（飞书边栏插件 URL）：`http://localhost:5173`
- 后端 API：`http://localhost:3000`
- 健康检查：`http://localhost:3000/api/health`

### 登录版额外配置（新项目）

登录版需要飞书 OAuth 回调地址，请在飞书开放平台应用配置中添加：

- 回调地址：`http://localhost:3000/api/auth/feishu/callback`

并在 `.env` 中确认以下变量：

```bash
FEISHU_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/feishu/callback
FEISHU_OAUTH_SCOPE=contact:user.base:readonly drive:drive drive:file docx:document:readonly wiki:wiki
SESSION_COOKIE_NAME=larkdocvar_session
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAMESITE=lax
SESSION_MAX_AGE_SECONDS=604800
FRONTEND_POST_LOGIN_URL=http://localhost:5173
```

登录态说明：

- 当前默认会话有效期是 `604800` 秒（7 天）。
- 在飞书内嵌 WebView 场景里，7 天通常也是最稳妥的上限。
- 如需跨站嵌入，可尝试 `SESSION_COOKIE_SAMESITE=none` 且同时启用 `SESSION_COOKIE_SECURE=true`（HTTPS 必须）。

相关接口：
- 登录跳转：`/api/auth/feishu/login`
- 会话查询：`/api/auth/session`
- 退出登录：`/api/auth/logout`
- 配置存取：`/api/configs`

## Docker 本地运行

1. 准备 `.env`

```bash
cp .env.example .env
```

2. 启动容器

```bash
docker compose up -d --build
```

3. 访问

- 插件地址：`http://127.0.0.1:18081`
- 健康检查：`http://127.0.0.1:18081/api/health`

说明：
- 容器内部服务端口默认 `3180`（变量：`CONTAINER_PORT`）
- 宿主机端口默认 `18081`
- `docker-compose.yml` 默认绑定 `127.0.0.1`，避免直接暴露公网和端口冲突

## 阿里云 ECS 一键部署（Docker）

仓库内已提供脚本：`scripts/deploy-aliyun-docker.sh`

示例：

```bash
./scripts/deploy-aliyun-docker.sh \
  --alias aliyun-prod \
  --app-dir /opt/larkdocvar-login \
  --host-port 18081
```

脚本行为：
- 打包当前项目并上传到 ECS
- 发布到 `/opt/larkdocvar-login/releases/<sha-time>`
- 复用/生成 `.env`
- 检查 `HOST_PORT` 冲突（被其他服务占用会中止）
- `docker compose up -d --build` 滚动更新
- 健康检查 `/api/health`

## GitHub Actions 自动部署

已提供工作流：`.github/workflows/deploy-aliyun-docker.yml`

触发方式：
- push 到 `main`
- 手动执行 `workflow_dispatch`

至少配置以下仓库 Secrets：
- `ALIYUN_SSH_KEY`（推荐）或 `ALIYUN_SSH_KEY_B64`

推荐同时配置：
- `ALIYUN_HOST`（默认 `112.124.103.65`）
- `ALIYUN_USER`（默认 `root`）
- `APP_DIR`（默认 `/opt/larkdocvar-login`）
- `APP_NAME`（默认 `larkdocvar-login`）
- `HOST_PORT`（默认 `18081`）
- `CONTAINER_PORT`（默认 `3180`）
- `APP_ENV_B64`（base64 编码后的 `.env` 内容，用于首次部署）

## 域名接入（后续 DNS）

目标域名：`login.larkdocvar.garyzheng.com`

推荐接入方式：
1. DNS 将该域名解析到 ECS 公网 IP
2. 在服务器 Caddy/Nginx 反代到 `127.0.0.1:18081`

Caddy 示例：

```caddyfile
login.larkdocvar.garyzheng.com {
  reverse_proxy 127.0.0.1:18081
}
```

完成后可将飞书边栏插件运行地址配置为：
- `https://login.larkdocvar.garyzheng.com`

## 常用命令

```bash
# 本地开发（自动装依赖）
npm run dev

# 仅构建前端
npm run build

# Docker
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
```
