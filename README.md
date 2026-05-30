# fbif-sidebar-docgen

![类型](https://img.shields.io/badge/%E7%B1%BB%E5%9E%8B-%E9%A3%9E%E4%B9%A6%E8%BE%B9%E6%A0%8F%E6%8F%92%E4%BB%B6-2563eb?style=flat-square)
![技术栈](https://img.shields.io/badge/%E6%8A%80%E6%9C%AF%E6%A0%88-React%20Express-0f766e?style=flat-square)
![状态](https://img.shields.io/badge/%E7%8A%B6%E6%80%81-%E5%8F%AF%E9%83%A8%E7%BD%B2-16a34a?style=flat-square)
![README](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-brightgreen?style=flat-square)

飞书插件：带 OAuth 登录的多维表格边栏插件，用于按云文档模板批量生成文档并将链接回写到表格。

## 仓库定位

- 分类：飞书多维表格边栏插件 / 云文档模板生成工具。
- 面向对象：需要从飞书云文档模板提取变量、批量套用多维表格记录并生成新文档的业务团队。
- 运行宿主：飞书多维表格边栏 iframe 插件，配套 Express 后端处理 OAuth、文档 API 和持久化。
- 与边栏插件合集的区别：本仓库是单一可部署插件应用，包含前端、后端、Docker 和部署脚本；插件合集仓库只集中管理多个独立子插件。

## 功能特性

- 飞书 OAuth 登录和会话保持
- 从飞书云文档 / Wiki 模板中提取 `{{变量}}`
- 自动匹配多维表格字段，并支持手动调整绑定
- 支持文本变量、固定值变量、链接字段和附件图片变量
- 批量生成全部记录或选中记录
- 自动创建 / 写回“生成文档”附件字段
- 支持脱离多维表格的独立文档生成模式
- 支持多维表格侧边栏凭证校验，云文档提取和生成接口不再只依赖手动 OAuth 登录态
- 支持协作者配置和文档所有权相关高级选项
- 支持模板配置历史和自动恢复
- 可选将用户配置同步到飞书多维表格
- 提供本地开发、Docker、本地预览和远程部署脚本

## 最新状态（2026-05-19）

- 侧边栏生成器已拆到 `src/components/document-generator/`，支持多维表格模式和独立文档生成模式。
- 字段映射支持“固定值”，字段刷新后会保留显式固定值绑定；图片变量可输入图片 URL，文本变量可直接输入固定文本。
- 生成结果写回目标改为附件字段，缺少目标字段时可创建“生成文档”附件字段。
- OAuth 按钮登录和扫码登录的失败回调会返回前端登录页展示可读错误，不再让用户看到接口 JSON；会话检查有 10 秒超时。
- 云文档提取和批量生成接口先尝试已登录会话，缺少会话时可用飞书多维表格侧边栏请求头完成访问校验。
- Docx API 模板列表、模板详情和版本接口返回 `thumbnail`，前端模板库直接消费 API 缩略图字段。
- 模板卡片和当前模板行支持复制模板名称，长模板名通过 `title` 保留完整可见名称。
- PostgreSQL schema 由 `server/migrations/` 管理，生产部署会固定 `POSTGRES_DATA_DIR` 并提供 `npm run backup:postgres` 备份命令。
- `/api/health` 会检查 `users`、`auth_sessions`、`saved_configs`、`schema_migrations` 等必需表，数据库未就绪时返回失败，避免“健康但无法登录”。
- TOS 对象支持 `DOCUMENT_TOS_ROOT_PREFIX`，模板资产和生成文件可在同一 bucket 下按项目/环境分层。

## 技术栈

- 前端：React、Vite、Tailwind CSS、lucide-react、`@lark-base-open/js-sdk`
- 后端：Express、TypeScript、tsx、Zod、Axios
- 存储：PostgreSQL
- 飞书能力：OAuth、云文档、Wiki、多维表格、用户目录
- 部署：Docker、Docker Compose、GitHub Actions

## 项目结构

```text
.
├── src/                         # React 边栏插件前端
├── server/
│   └── src/
│       ├── index.ts             # Express API 和 OAuth 会话
│       ├── auth.ts              # 会话 cookie / X-Session-Token 解析
│       ├── oauthRoutes.ts       # 飞书按钮、扫码和客户端内授权路由
│       ├── bitableSidebarAuth.ts # 多维表格侧边栏凭证校验
│       ├── feishu.ts            # 飞书文档 / 用户相关 API
│       ├── storage.ts           # PostgreSQL 持久化
│       ├── migrations.ts        # 数据库迁移执行器
│       └── bitableConfigSync.ts # 可选的多维表格配置同步
├── server/migrations/           # PostgreSQL schema migrations
├── scripts/
│   ├── dev-up.sh                # 本地开发启动脚本
│   ├── backup-postgres.sh       # PostgreSQL 备份脚本
│   └── deploy-fbif-sidebar-docgen.sh  # Docker 远程部署脚本
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 快速上手

插件内的基本流程：

1. 登录插件，右上角显示账号即表示成功。
2. 粘贴模板文档链接，点击“提取变量”。
3. 检查变量映射，必要时手动调整字段绑定。
4. 点击“全部生成”或“生成选中项”。
5. 系统生成文档并将链接写回多维表格。

模板权限说明：

- 模板变量提取使用当前登录用户的 OAuth token。
- 模板文档需要对实际使用插件的用户开放阅读权限。
- 飞书应用仍需要配置凭证，用于登录、文档和后续 API 能力。

## 本地开发

复制环境变量模板：

```bash
cp .env.example .env
```

填写飞书应用配置：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_FBIF_APP_ID=cli_fbif_xxx
FEISHU_FBIF_APP_SECRET=xxx
FEISHU_FUDE_APP_ID=cli_fude_xxx
FEISHU_FUDE_APP_SECRET=xxx
FEISHU_REDIRECT_BASE=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15433/larkdocvar
PORT=3000
HOST=0.0.0.0
```

启动开发环境：

```bash
npm install
docker compose up -d postgres
npm run dev
```

默认地址：

- 前端插件地址：`http://localhost:5173`
- 后端 API：`http://localhost:3000`
- 健康检查：`http://localhost:3000/api/health`
- 本地 PostgreSQL：`127.0.0.1:15433`（`DATABASE_URL` 默认示例可直接连接）

健康检查返回的 `databaseReady` 必须为 `true`，才表示登录和配置存储所需数据表都已就绪。

## 飞书 OAuth 配置

在飞书开放平台应用中添加 OAuth 回调地址：

```text
http://localhost:3000/auth/feishu/fbif/callback
http://localhost:3000/auth/feishu/fbif/qr-callback
http://localhost:3000/auth/feishu/fude/callback
http://localhost:3000/auth/feishu/fude/qr-callback
```

本地 `.env` 中确认：

```bash
FEISHU_REDIRECT_BASE=http://localhost:3000
FEISHU_FBIF_OAUTH_REDIRECT_URI=
FEISHU_FBIF_QR_REDIRECT_URI=
FEISHU_FUDE_OAUTH_REDIRECT_URI=
FEISHU_FUDE_QR_REDIRECT_URI=
FEISHU_OAUTH_SCOPE=contact:user.base:readonly drive:drive drive:file docx:document:readonly wiki:wiki
SESSION_COOKIE_NAME=larkdocvar_session
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAMESITE=lax
SESSION_MAX_AGE_SECONDS=604800
FRONTEND_POST_LOGIN_URL=http://localhost:5173
```

会话说明：

- 默认会话有效期为 7 天。
- 本地开发通常使用 `SESSION_COOKIE_SAMESITE=lax`。
- 跨站嵌入或 HTTPS 部署时，可按实际场景调整 SameSite 和 Secure 设置。
- 如果不同飞书应用需要独立回调地址，优先填写 `FEISHU_FBIF_*_REDIRECT_URI` / `FEISHU_FUDE_*_REDIRECT_URI`；为空时统一由 `FEISHU_REDIRECT_BASE` 推导。
- 飞书桌面侧边栏登录必须留在当前插件面板内。支持 H5 WebApp 授权容器时使用客户端内授权；真实 PC Lark 多维表格侧边栏不是 H5 WebApp 容器时，直接切到插件内扫码登录。普通浏览器使用 `/auth/feishu/:appKey/login` 当前页跳转 OAuth。
- `/api/auth/feishu/:appKey/start` 和 `/login-status` 的 JSON handoff 已停用，避免用已知 state 领取他人 session。
- 客户端内授权成功后，前端会把后端返回的 `session_token` 写入嵌入式本地存储，并在同源请求里带 `X-Session-Token`。

## 可选：侧边栏访问校验

`/api/template/variables` 和 `/api/documents/generate` 会先尝试读取当前登录会话；如果没有有效会话，会改用飞书多维表格侧边栏请求头校验来源：

- `x-bitable-base-id`
- `x-bitable-table-id`
- `x-bitable-base-user-id`
- `x-bitable-tenant-key`

可用环境变量限制允许访问的 Base、数据表和租户：

```bash
BITABLE_SIDEBAR_ALLOWED_BASE_IDS=base_token_1,base_token_2
BITABLE_SIDEBAR_ALLOWED_TABLE_IDS=table_id_1,table_id_2
FEISHU_ALLOWED_TENANT_KEYS=tenant_key_1,tenant_key_2
```

`BITABLE_SIDEBAR_ALLOWED_BASE_IDS` 未配置时，服务端使用代码里的默认 Base allowlist；`BITABLE_SIDEBAR_ALLOWED_TABLE_IDS` 为空表示不限制表。生产环境建议显式填写，避免插件被非预期多维表格调用。

## 可选：多维表格配置同步

后端可将用户模板配置同步到飞书多维表格。需要在 `.env` 中配置：

```bash
BITABLE_SYNC_ENABLED=true
BITABLE_APP_TOKEN=base_app_token
BITABLE_TABLE_ID=table_id
BITABLE_SYNC_COOLDOWN_MS=60000
```

说明：

- `BITABLE_SYNC_ENABLED=false` 可关闭同步。
- `BITABLE_SYNC_COOLDOWN_MS` 用于限制频繁写入。
- 应使用部署环境自己的多维表格 App Token 和表 ID。

## API 概览

Docx API 是本项目的底层契约。新增能力必须先更新 [docs/docx-api-integration.md](docs/docx-api-integration.md)，并在文档最前面的「更新日志」表格追加记录；本地 Markdown 更新后同步到飞书云文档：[Docx API 接入文档](https://foodtalks.feishu.cn/docx/GMc4diq86oTS9SxQ8txcDPYenZ2)。

常用接口：

- `GET /api/health`：健康检查
- `GET /api/auth/feishu/:appKey/client-config`：返回飞书客户端内授权所需的 `app_id`
- `POST /api/auth/feishu/:appKey/client-code`：接收客户端内授权 code，创建后端会话并返回嵌入式会话 `session_token`
- `GET /api/auth/feishu/:appKey/start`：已停用的外部 OAuth JSON handoff，固定返回 410
- `GET /api/auth/feishu/:appKey/login-status`：已停用的外部 OAuth JSON handoff 轮询，固定返回 410
- `GET /auth/feishu/fbif/login`：跳转 FBIF 飞书登录
- `GET /auth/feishu/fude/login`：跳转富的飞书登录
- `GET /auth/feishu/:appKey/callback`：OAuth 回调
- `GET /auth/feishu/:appKey/qr-config`：扫码登录配置
- `GET /auth/feishu/:appKey/qr-callback`：扫码登录回调
- `GET /api/auth/session`：查询当前会话
- `POST /api/auth/logout`：退出登录
- `POST /api/template/variables`：提取模板变量
- `POST /api/documents/generate`：批量生成文档
- `GET /api/templates/saved`：模板配置历史
- `GET /api/configs/auto`：自动恢复配置
- `GET /api/users/search`：搜索用户，用于协作者和所有权配置

Docx v1 API：

- `POST /api/v1/document-templates`：上传或登记 Docx 模板，支持 `url` 或 `fileBase64`
- `GET /api/v1/document-templates`：读取模板列表，包含当前版本变量和 `thumbnail`
- `GET /api/v1/document-templates/:templateId`：读取模板详情和版本信息
- `POST /api/v1/document-templates/:templateId/versions`：新增模板版本
- `DELETE /api/v1/document-templates/:templateId`：软删除模板
- `POST /api/v1/document-renders`：单份文档生成，支持 `output.includeFileBase64`
- `GET /api/v1/document-renders/downloads/:id`：本地开发存储的临时下载地址
- `POST /api/v1/document-renders/batch`：同步批量生成，单批最多 100 条
- `POST /api/v1/document-render-jobs`：异步批量任务，单任务最多 500 条
- `GET /api/v1/document-render-jobs/:jobId` / `results`：查询异步任务进度和结果

## Docker 本地运行

```bash
cp .env.example .env
docker compose up -d --build
```

默认地址：

- 插件入口：`http://127.0.0.1:19094`（默认 `HOST_PORT`）
- 健康检查：`http://127.0.0.1:19094/api/health`

端口相关变量：

- `HOST_PORT`：宿主机映射端口
- `CONTAINER_PORT`：容器内部服务端口
- `POSTGRES_HOST_PORT`：宿主机 PostgreSQL 映射端口
- `POSTGRES_DATA_DIR`：PostgreSQL 数据目录。生产部署脚本会默认固定到部署根目录下的 `data/postgres`；本地不填时使用 Docker named volume。
- `DOCUMENT_TOS_ROOT_PREFIX`：TOS 统一项目根目录，例如 `fbif-sidebar-docgen/prod`
- `DOCUMENT_TEMPLATE_TOS_PREFIX` / `DOCUMENT_RENDER_TOS_PREFIX`：模板资产和生成文件前缀，默认 `templates` / `renders`
- `DOCUMENT_RENDER_STORAGE_PROVIDER`：生成文件存储提供方；同时配置 OSS 和 TOS 时可设为 `tos`

## 部署

仓库提供 Docker 远程部署脚本：

```bash
./scripts/deploy-fbif-sidebar-docgen.sh \
  --host 121.40.214.5 \
  --user root \
  --identity-file "/path/to/vibecoding.pem" \
  --app-dir /opt/fbif-sidebar-docgen \
  --host-port 19094 \
  --postgres-host-port 15433
```

脚本会打包当前项目、上传到服务器、复用或生成 `.env`、固定 `POSTGRES_DATA_DIR`、检查端口冲突、执行 `docker compose up -d --build`，并访问 `/api/health` 做健康检查。

仓库也包含 GitHub Actions 部署工作流。使用前请在仓库 Secrets 中配置 SSH Key、目标主机、部署目录、端口和 `.env` 内容等信息。

## PostgreSQL 数据和备份

生产环境不要把 PostgreSQL 数据放在 release 目录或 `current` 软链下面。部署脚本会在 `.env` 缺少 `POSTGRES_DATA_DIR` 时写入稳定路径；如果检测到旧容器或 `.env` 仍指向历史 release / `current` 目录，脚本会把数据复制到稳定目录后再启动。

手动备份当前 Docker PostgreSQL：

```bash
npm run backup:postgres
```

默认备份到 `./backups/postgres`，生成 `pg_dump -Fc` 格式文件。可用环境变量调整：

```bash
POSTGRES_BACKUP_DIR=/opt/fbif-sidebar-docgen/backups/postgres
POSTGRES_BACKUP_KEEP_DAYS=14
```

数据表结构通过 `server/migrations/` 管理，服务启动时会记录已执行版本到 `schema_migrations`。新增或修改表结构时，新增 migration 文件，不要直接把一次性 SQL 写进业务代码。

## 常用命令

```bash
npm run dev          # 本地开发，启动前端和后端
npm run dev:raw      # 直接并行运行前端和后端
npm run build        # 构建前端
npm run preview      # 预览前端构建结果
npm run start        # 启动后端服务
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
npm run backup:postgres
```

## 注意事项

- 真实飞书应用密钥、OAuth token、会话 cookie 或生产环境 `.env` 可以放 GitHub Actions Secrets、部署平台密钥或本地未提交的 `.env.local`，不要提交到仓库正文、示例、日志或飞书云文档正文。
- 模板变量名称建议与多维表格字段名称保持一致，可减少手动绑定。
- 图片变量依赖附件字段中的可访问 URL，生成前请确认附件字段数据完整。
- 生产环境应使用 HTTPS、真实域名和稳定的 OAuth 回调地址。
- 登录、OAuth、cookie 或 iframe 回跳相关改动，必须按 `docs/auth-login-incident-review-2026-05-14.md` 的失败分支清单复验，并在飞书桌面真实侧边栏点击按钮验证；不能只看普通页面或 Chrome 已登录。客户端内授权或扫码登录都应停留在当前插件面板，侧边栏内不应自动打开外部授权页。
