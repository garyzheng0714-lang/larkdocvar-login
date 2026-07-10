# fbif-sidebar-docgen

![可见性](https://img.shields.io/badge/%E5%8F%AF%E8%A7%81%E6%80%A7-%E5%85%AC%E5%BC%80%E4%BB%93%E5%BA%93-0A66C2?style=flat-square)
![前端](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827)
![后端](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)
![数据库](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![CI](https://img.shields.io/badge/main-%E6%B5%8B%E8%AF%95%E5%90%8E%E9%83%A8%E7%BD%B2-16a34a?style=flat-square)

飞书多维表格侧边栏文档生成工具。它同时支持“飞书云文档模板”和“Docx 模板资产”两条链路，并提供可信登录、模板版本、批量任务、对象存储与附件回写所需的前后端能力。

## 导航

- [产品边界](#产品边界)
- [两条生成链路](#两条生成链路)
- [架构](#架构)
- [快速开始](#快速开始)
- [登录与会话](#登录与会话)
- [Docx API](#docx-api)
- [配置与存储](#配置与存储)
- [测试与部署](#测试与部署)
- [安全边界](#安全边界)
- [文档索引](#文档索引)

## 产品边界

| 项目 | 说明 |
| --- | --- |
| 宿主 | 飞书多维表格侧边栏，也支持独立 Docx API 调用 |
| 云文档输入 | 飞书云文档 / Wiki 模板中的 `{{变量}}` |
| Docx 输入 | 服务端持久化的 `.docx` 模板资产与 `templateId` |
| 数据输入 | 多维表格记录、固定值、链接与附件图片 |
| 输出 | 新飞书云文档，或可下载的 Docx / 可选 PDF 预览 |
| 持久化 | PostgreSQL 会话/配置/任务/审计；TOS 模板资产；TOS 或 OSS 生成文件 |

本仓库不是通用办公套件，也不提供无鉴权的公网文档转换服务。两条生成链路共享侧边栏入口，但 API、权限和存储语义不同，不能混用。

## 两条生成链路

### 1. 飞书云文档模板

1. 已登录用户粘贴飞书云文档或 Wiki 模板链接。
2. 后端使用当前用户 OAuth 会话提取 `{{变量}}`。
3. 前端自动匹配多维表格字段，并允许固定值/手动绑定。
4. 后端按记录复制和替换云文档内容。
5. 前端把生成结果写回附件字段。

边界：`/api/template/variables`、`/api/documents/generate` 和 `/api/users/search` 当前都要求服务端可信会话；仅发送 `X-Bitable-*` 宿主上下文头不能替代登录。

### 2. Docx 模板资产

1. 业务系统或已登录侧边栏创建模板资产，获得稳定 `templateId`。
2. 新版本以 `versionId` 保存；不指定版本时使用当前版本。
3. 单份、同步批量或异步任务提交变量。
4. 服务端校验缺失/多余变量、Docx ZIP 安全与图片输入。
5. 生成文件写入对象存储并返回限时下载信息；可选经 Gotenberg 生成 PDF 预览。

生产模板资产必须使用 TOS；生成文件可使用 TOS 或 OSS。本地存储仅用于开发。

## 架构

```text
飞书多维表格 sidebar
   │ Base SDK / 字段绑定 / 附件写回
   ▼
React + Vite
   │ cookie / X-Session-Token
   ▼
Express API
   ├─ 飞书 client-code / OAuth / QR / handoff
   ├─ 云文档变量提取与生成
   ├─ Docx 模板、版本、单份/批量/异步任务
   ├─ 来源校验、API Key、租户与所有权边界
   └─ PostgreSQL migration / 健康检查
          │
          ├────► 飞书 OpenAPI
          ├────► TOS（模板 + 可选生成文件）
          ├────► OSS（可选生成文件）
          └────► Gotenberg（可选 PDF 预览）
```

### PostgreSQL 表

服务启动时执行 `server/migrations/`，并要求以下表就绪：

- `users`：登录用户资料。
- `auth_sessions`：OAuth token 与服务端会话。
- `saved_configs`：用户模板映射配置。
- `render_jobs`：异步任务状态、租约、进度和结果。
- `render_audit`：生成审计记录。
- `schema_migrations`：已执行 migration。

`/api/health` 在配置 `DATABASE_URL` 时会检查这些表；`databaseReady=true` 才表示会话和任务持久化可用。

## 快速开始

要求：Node.js 22（与 CI 一致）、npm、Docker Compose。

### Docker Compose

```bash
cp .env.example .env
# 填写本地需要的飞书凭证、数据库和存储变量
docker compose up -d --build
curl http://127.0.0.1:19094/api/health
```

Compose 包含：

- 应用：宿主默认 `127.0.0.1:19094`，容器默认 `3180`。
- PostgreSQL 16：宿主默认 `127.0.0.1:15433`。
- Gotenberg 8：只在 Compose 内网提供 PDF 转换，不映射宿主端口。

### 前后端开发

```bash
npm ci
docker compose up -d postgres gotenberg
cp .env.example .env
npm run dev
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Vite 前端 | `http://localhost:5173` |
| Express API | `http://localhost:3000` |
| 健康检查 | `http://localhost:3000/api/health` |

构建与启动：

```bash
npm run build
npm run start:prod
```

## 登录与会话

支持三类可信登录路径：

| 场景 | 入口 | 会话交付 |
| --- | --- | --- |
| 支持飞书 H5 SDK 的容器 | `client-config` + `client-code` | httpOnly cookie + `X-Session-Token` 响应头 |
| 插件内扫码 | `qr-config` + `qr-callback` | cookie，并通过安全回跳供嵌入页恢复 |
| 桌面侧边栏外部 OAuth | `handoff/start` + OAuth + `handoff/:code` | 一次性、5 分钟、绑定发起者 `open_id` 的 handoff |

主要路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth/feishu/:appKey/client-config` | 返回客户端授权所需 app ID，不返回 secret |
| `POST` | `/api/auth/feishu/:appKey/client-code` | code 换用户 token 并创建会话 |
| `GET` | `/auth/feishu/:appKey/login`、`callback` | 外部 OAuth 跳转与回调 |
| `GET` | `/auth/feishu/:appKey/qr-config`、`qr-callback` | 插件内扫码配置与回调 |
| `POST` | `/api/auth/feishu/:appKey/handoff/start` | 创建与 Base 用户绑定的一次性 handoff |
| `GET` | `/api/auth/feishu/:appKey/handoff/:code` | 单次消费 handoff 状态和 session |
| `GET` | `/api/auth/session` | 查询/续传当前会话 |
| `POST` | `/api/auth/logout` | 删除会话并清理 cookie |

浏览器 fallback 会把嵌入式 session token 保存在 `localStorage`，仅对同源请求加 `X-Session-Token`。生产必须使用 HTTPS、严格 CSP，并把 XSS 视为会话泄露风险。

## Docx API

Docx v1 路由同时接受：

- `Authorization: Bearer <DOCUMENT_RENDER_API_KEY>`；
- `x-api-key: <DOCUMENT_RENDER_API_KEY>`；
- 已登录可信会话。

开发环境未配置 API key 时允许本地调用；生产环境缺 key 且无有效会话时返回 401。

### 模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/document-templates` | 创建模板资产，支持 URL 或 Base64 文件 |
| `GET` | `/api/v1/document-templates` | 列表；返回当前版本变量与缩略图 |
| `GET` | `/api/v1/document-templates/:templateId` | 模板详情 |
| `GET` | `/api/v1/document-templates/:templateId/versions` | 版本列表 |
| `POST` | `/api/v1/document-templates/:templateId/versions` | 新增并激活版本 |
| `DELETE` | `/api/v1/document-templates/:templateId` | 软删除模板 |

### 生成

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/document-renders` | 单份生成；支持缺失/多余变量策略与可选 Base64/PDF 预览 |
| `GET` | `/api/v1/document-renders/downloads/:id` | 仅 local 开发存储的临时下载 |
| `POST` | `/api/v1/document-renders/batch` | 同步批量，最多 100 条 |
| `POST` | `/api/v1/document-render-jobs` | 异步任务，最多 500 条 |
| `GET` | `/api/v1/document-render-jobs/:jobId` | 查询任务进度 |
| `GET` | `/api/v1/document-render-jobs/:jobId/results` | 查询逐条结果 |

变量策略：

- `missingStrategy=fail | blank`：缺少模板变量时失败或填空。
- `unusedStrategy=error | ignore`：提交模板不存在的变量时失败或忽略；默认保护性失败。
- `output.includeFileBase64`：把文件内容随响应返回，适合受控的小文件调用。
- `output.includePdfPreview`：调用 Gotenberg 生成 PDF 预览。

完整合同、错误码和示例以 [`docs/docx-api-integration.md`](docs/docx-api-integration.md) 为准。

## 配置与存储

完整变量见 [`.env.example`](.env.example)。生产关键项：

| 分组 | 关键变量 | 说明 |
| --- | --- | --- |
| 飞书应用 | `FEISHU_*_APP_ID`、`FEISHU_*_APP_SECRET`、`FEISHU_REDIRECT_BASE` | 多应用登录与回调 |
| 租户 | `FEISHU_ALLOWED_TENANT_KEYS` | 生产必填 allowlist |
| 会话 | `SESSION_COOKIE_SECURE`、`SESSION_COOKIE_SAMESITE`、`SESSION_MAX_AGE_SECONDS` | iframe cookie 策略 |
| 数据库 | `DATABASE_URL`、`POSTGRES_DATA_DIR` | 持久化与稳定数据目录 |
| Docx 鉴权 | `DOCUMENT_RENDER_API_KEY` | 服务到服务 API key |
| 模板存储 | `DOCUMENT_TEMPLATE_STORAGE_PROVIDER=tos`、`TOS_*` | 生产模板资产必须 TOS |
| 生成存储 | `DOCUMENT_RENDER_STORAGE_PROVIDER=tos|oss` 与对应凭证 | 最终文件与签名下载 URL |
| 对象前缀 | `DOCUMENT_TOS_ROOT_PREFIX`、模板/生成 prefix | 项目与环境隔离 |
| PDF | `GOTENBERG_URL` | Docx → PDF 预览服务 |
| 配置门禁 | `DOCUMENT_RENDER_STRICT_CONFIG=true` | 生产关键配置缺失时拒绝启动 |
| CORS | `CORS_ALLOWED_ORIGINS` | 跨域部署的精确来源 allowlist |

配置自检默认只记录告警。生产建议启用 `DOCUMENT_RENDER_STRICT_CONFIG=true`，避免缺少 API key、租户 allowlist、数据库或对象存储时仍启动部分可用服务。

### 数据与备份

生产 PostgreSQL 数据目录必须位于 release/current 软链之外的稳定绝对路径。备份：

```bash
npm run backup:postgres
```

默认生成 `pg_dump -Fc` 文件；保留目录与天数可用 `POSTGRES_BACKUP_DIR`、`POSTGRES_BACKUP_KEEP_DAYS` 调整。恢复步骤见运维手册，备份不等于恢复验证。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地依赖、前端与后端 |
| `npm run typecheck` | TypeScript 检查 |
| `npm test` | Node test runner 执行前后端测试 |
| `npm run build` | 类型检查 + Vite 构建 |
| `npm run verify:secrets` | 检查被跟踪文件中的敏感值 |
| `npm run verify:document-render-milestone1` | Docx 里程碑完整验证 |
| `npm run audit:document-render-milestone1` | 生成验收审计 |
| `npm run backup:postgres` | PostgreSQL 备份 |
| `npm run docker:up` / `docker:down` | 管理 Compose 栈 |

## 测试与部署

提交前：

```bash
npm ci
npm run typecheck
npm test
npm run build:web
npm run verify:secrets
```

`.github/workflows/deploy-fbif-sidebar-docgen.yml` 在 `main` push 或手动触发时：

1. 安装依赖、类型检查、测试并构建前端。
2. 打包不含本地 env、依赖和构建产物的 release。
3. 通过部署 secrets 上传到版本化 release 目录。
4. 保持 PostgreSQL 稳定数据目录，重建 Compose 服务。
5. 轮询 `/api/health` 验证应用与数据库。

工作流存在不等于某次部署成功；应同时检查 Actions 结果、`databaseReady`、登录失败分支、对象存储签名下载、真实飞书侧边栏和附件回写。

## 安全边界

- 这是公开仓库。任何应用 secret、OAuth token、session、数据库连接串、对象存储凭证、真实 Base/Table/Tenant ID 都不得进入 README、源码、日志样例或测试夹具。
- 生产必须配置 `FEISHU_ALLOWED_TENANT_KEYS`；空 allowlist 会拒绝登录。
- `DOCUMENT_RENDER_API_KEY` 应与登录 session 分离管理并定期轮换；禁止把 API key 放入浏览器 URL。
- 模板下载与图片变量包含 SSRF 防护、大小和 ZIP 解压边界；不要为兼容单个素材而允许内网或私有地址。
- 模板所有权和异步任务查询与提交身份绑定；管理员列表只通过环境变量注入。
- OAuth state 经过签名并有时效；handoff 绑定 Base `open_id` 且单次消费。登录改动必须覆盖 client-code、QR、OAuth/handoff、过期、身份不匹配和 iframe 会话恢复。
- `localStorage` session 是嵌入式兼容方案，必须配合同源、HTTPS、CSP 和最小第三方脚本面。
- TOS/OSS 签名 URL 有 TTL；客户端只使用 API 返回的 `download.url`，不要推断对象 key 或持久化过期 URL。
- 仓库没有 LICENSE 文件，不应假定可自由再发布。

## 项目结构

```text
.
├── src/                         # React 侧边栏与 Base SDK 适配
├── server/
│   ├── src/                     # Express、登录、云文档与 Docx API
│   └── migrations/              # PostgreSQL migration
├── scripts/                     # 开发、部署、备份与文档同步
├── docs/                        # API、架构、运维、ADR 与验收材料
├── .github/workflows/           # 测试后部署
├── docker-compose.yml           # app + PostgreSQL + Gotenberg
├── Dockerfile
└── .env.example
```

## 文档索引

- [`CONTEXT.md`](CONTEXT.md)：两条生成链路、术语、路由与存储边界。
- [`docs/project-flow.md`](docs/project-flow.md)：业务流程图与工作流接入说明；其中环境标识仅限内部运维使用。
- [`docs/docx-api-integration.md`](docs/docx-api-integration.md)：Docx API 权威合同与更新日志。
- [`docs/docx-api-architecture.md`](docs/docx-api-architecture.md)：模板、渲染、存储和身份架构。
- [`docs/docx-operator-runbook.md`](docs/docx-operator-runbook.md)：生产配置、监控、备份、恢复与排障。
- [`docs/docx-api-milestone1-audit.md`](docs/docx-api-milestone1-audit.md)：里程碑验收口径与证据。
- [`docs/auth-login-incident-review-2026-05-14.md`](docs/auth-login-incident-review-2026-05-14.md)：登录事故复盘与强制回归清单。
- [`docs/adr/0001-oauth-token-exchange-not-unified.md`](docs/adr/0001-oauth-token-exchange-not-unified.md)：OAuth token 交换的历史架构决策；实现路径变化时以当前代码为准。
- [`docs/adr/0002-generation-mode-no-strategy-seam.md`](docs/adr/0002-generation-mode-no-strategy-seam.md)：暂不为两种生成模式引入策略抽象。
