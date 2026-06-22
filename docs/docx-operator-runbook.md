# Docx API 运维手册

更新时间：2026-06-22

## 必备环境变量

### 鉴权

| 变量 | 必需性 | 说明 |
|---|---|---|
| `DOCUMENT_RENDER_API_KEY` | 生产必需 | 服务端到服务端 API Key。生产环境没有 API Key 或可信会话时，Docx API 不会匿名放行；业务系统需传 `Authorization: Bearer` 或 `x-api-key`。 |
| `FEISHU_FBIF_APP_ID` / `FEISHU_FBIF_APP_SECRET` | 云文档模板必需 | FBIF 飞书云文档模板路径使用；`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 仍作为 FBIF 兼容别名。旧 OAuth 入口当前退役，恢复前必须重新做真实侧边栏登录验收。 |
| `FEISHU_FUDE_APP_ID` / `FEISHU_FUDE_APP_SECRET` | 富的入口按需 | 富的飞书云文档能力使用。 |
| `FEISHU_REDIRECT_BASE` | 旧登录链路保留项 | 当前 OAuth 登录入口已退役并返回 410；保留该变量仅用于历史兼容和后续显式恢复登录链路时复用。 |
| `FEISHU_FBIF_OAUTH_REDIRECT_URI` / `FEISHU_FBIF_QR_REDIRECT_URI` | 旧登录链路保留项 | 当前不参与侧边栏主流程。 |
| `FEISHU_FUDE_OAUTH_REDIRECT_URI` / `FEISHU_FUDE_QR_REDIRECT_URI` | 旧登录链路保留项 | 当前不参与侧边栏主流程。 |
| `FEISHU_ALLOWED_TENANT_KEYS` | 生产必需 | 逗号分隔的飞书租户白名单；为空只允许非生产环境。 |
| `FRONTEND_POST_LOGIN_URL` | 旧登录链路保留项 | GitHub Actions 仍会写成 `https://{APP_DOMAIN}`；当前侧边栏主流程不依赖它。 |
| `OAUTH_STATE_SIGNING_SECRET` | 可选 | OAuth state 签名密钥；不填时使用当前应用密钥派生。 |
| `CORS_ALLOWED_ORIGINS` | 跨域部署时配置 | 逗号分隔允许来源；同源请求不需要。 |
| `DATABASE_URL` | 侧边栏必需 | 保存登录会话、飞书云文档模板配置和异步 Docx 批量生成任务。 |

### 生成文件存储

| 变量 | 说明 |
|---|---|
| `DOCUMENT_RENDER_STORAGE_PROVIDER` | 可选 `oss` 或 `tos`；同时配置 OSS/TOS 时建议显式填写。 |
| `DOCUMENT_RENDER_OSS_ACCESS_KEY_ID` / `DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET` / `DOCUMENT_RENDER_OSS_BUCKET` / `DOCUMENT_RENDER_OSS_REGION` | 阿里云 OSS 生成文件存储。 |
| `TOS_ACCESS_KEY` / `TOS_SECRET_KEY` / `TOS_BUCKET` / `TOS_REGION` / `TOS_ENDPOINT` | 火山引擎 TOS 生成文件存储，也可复用为模板存储。 |
| `DOCUMENT_TOS_ROOT_PREFIX` | 可选的 TOS 统一根目录，例如 `fbif-sidebar-docgen/prod`；为空时保留历史根目录。 |
| `DOCUMENT_RENDER_TOS_PREFIX` | TOS 生成文件前缀，推荐 `renders`；最终路径为 `{root}/{render-prefix}/YYYY/MM/DD/{requestId}.docx`。 |
| `DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS` | 默认下载链接有效期，建议用秒。 |
| `DOCUMENT_RENDER_PUBLIC_BASE_URL` | 需要返回绝对下载 URL 时配置。 |
| `GOTENBERG_URL` | 可选。配置后 `output.includePdfPreview=true` 会调用 `{GOTENBERG_URL}/forms/libreoffice/convert` 生成 PDF 预览。 |
| `GOTENBERG_TIMEOUT_MS` | 可选。PDF 预览转换超时时间，默认 30000。 |

### 模板资产存储

| 变量 | 说明 |
|---|---|
| `DOCUMENT_TEMPLATE_STORAGE_PROVIDER` | 可选 `tos`。为空时会跟随 `DOCUMENT_RENDER_STORAGE_PROVIDER`。 |
| `DOCUMENT_TEMPLATE_TOS_PREFIX` | 模板资产前缀，推荐 `templates`；最终路径为 `{root}/{template-prefix}/...`。 |
| `DOCUMENT_TEMPLATE_STORAGE_DIR` | 本地开发模板存储目录；生产环境不能依赖它。 |
| `DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS` | 仅本地实验使用；生产不要开启。 |

### PostgreSQL 数据目录和备份

| 变量 | 说明 |
|---|---|
| `POSTGRES_DATA_DIR` | PostgreSQL 宿主机数据目录。生产必须是稳定绝对路径，不能落在 release 目录。部署脚本缺省写入 `{APP_DIR}/data/postgres`。 |
| `POSTGRES_BACKUP_DIR` | `scripts/backup-postgres.sh` 的备份输出目录，默认 `./backups/postgres`。 |
| `POSTGRES_BACKUP_KEEP_DAYS` | 备份保留天数，默认 14 天。 |

推荐的 TOS bucket 结构：

```text
fbif-sidebar-docgen/prod/
├── templates/_index.json
├── templates/{templateId}/metadata.json
├── templates/{templateId}/versions/v001/source.docx
├── renders/YYYY/MM/DD/{requestId}.docx
└── renders/diagnostics/YYYY/MM/DD/{timestamp}.txt
```

## 本地启动

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run dev
```

开发服务：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`
- 健康检查：`http://localhost:3000/api/health`
- PostgreSQL：`127.0.0.1:15433`

## 冒烟检查

```bash
npm test
npm run build
npm run verify:secrets
git diff --check
```

对象存储预检：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:oss
```

如果需要把 OSS 配置写入本机私有 `.env.local`，可以使用配置脚本。脚本只输出写入了哪些字段，不会打印 AccessKey 值；生成的 `.env.local` 会被 git 忽略，并设置为仅当前用户可读写。

```bash
npm run configure:oss-local <<'EOF'
DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=your_access_key_id
DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET=your_access_key_secret
DOCUMENT_RENDER_OSS_BUCKET=your_bucket_name
DOCUMENT_RENDER_OSS_REGION=cn-beijing
EOF
```

也兼容常见 OSS 别名：`ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET` / `ALIYUN_OSS_BUCKET` / `ALIYUN_OSS_REGION`，以及 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_BUCKET` / `OSS_REGION` / `OSS_REGION_ID`。如果同时存在 OSS 和 TOS 配置，用 `DOCUMENT_RENDER_STORAGE_PROVIDER=tos` 或 `DOCUMENT_RENDER_STORAGE_PROVIDER=oss` 显式选择。

### OSS 预检失败

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| `NoSuchBucket` | bucket 名称写错、region 不匹配，或该 AccessKey 所属账号看不到这个 bucket。 | 在阿里云 OSS 控制台确认 bucket 名称和地域；`DOCUMENT_RENDER_OSS_REGION` 可以写 `cn-beijing` 或 `oss-cn-beijing`。 |
| `InvalidAccessKeyId` | AccessKey 不存在、已禁用，或不属于可访问该 bucket 的账号。 | 在 RAM/AccessKey 管理页面确认 AccessKey 状态为启用，并确认它属于拥有目标 bucket 权限的账号。 |
| `AccessDenied` | AccessKey 有效但权限不足。 | 给该 AccessKey 对目标 bucket 的 `PutObject`、`GetObject`、`DeleteObject`、`ListBuckets` 或等效最小权限。 |
| `SignatureDoesNotMatch` | Secret、region 或签名参数不匹配。 | 重新写入 AccessKey Secret，并核对 bucket region。 |

OSS 最小权限：

| 项目 | 必需性 | 说明 |
|---|---|---|
| 目标 bucket 已存在 | 必需 | `DOCUMENT_RENDER_OSS_BUCKET` 必须是当前 AccessKey 所属账号可访问的真实 bucket。 |
| bucket 地域匹配 | 必需 | `DOCUMENT_RENDER_OSS_REGION` 必须和 bucket 地域一致。 |
| AccessKey 状态启用 | 必需 | RAM/AccessKey 页面中该 AccessKey 必须为启用状态。 |
| `PutObject` | 必需 | 允许写入 `DOCUMENT_RENDER_OSS_PREFIX` 或 TOS `{DOCUMENT_TOS_ROOT_PREFIX}/{DOCUMENT_RENDER_TOS_PREFIX}` 下的生成文件和预检文件。 |
| `GetObject` | 必需 | 允许通过签名 URL 下载刚生成的 Docx。 |
| `DeleteObject` | 必需 | 允许预检脚本删除诊断文件，避免留下测试对象。 |
| `ListBuckets` | 仅诊断 | 只用于失败时生成可读诊断；没有这个权限时，真实 put/signature/download/delete 通过仍可完成 OSS 链路验收。 |

Docx 里程碑完整验收：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:document-render-milestone1
npm run audit:document-render-milestone1
```

## PostgreSQL 备份和恢复

创建当前数据库备份：

```bash
scripts/backup-postgres.sh
```

生产服务器建议用绝对目录保存备份：

```bash
POSTGRES_BACKUP_DIR=/opt/fbif-sidebar-docgen/backups/postgres scripts/backup-postgres.sh
```

备份文件是 `pg_dump -Fc` 格式。恢复前先确认目标数据库为空或已确认要覆盖，再使用 `pg_restore`。恢复命令示例：

```bash
docker exec -i fbif-sidebar-docgen-postgres pg_restore -U postgres -d larkdocvar --clean --if-exists < backup.dump
```

数据库表结构通过 `server/migrations/` 管理。服务启动时会先执行未应用的 migration，并记录到 `schema_migrations`。新增表或字段时，新建 migration 文件，不要把一次性 DDL 混进业务函数。

生产健康检查必须同时看 `databaseConfigured` 和 `databaseReady`。`databaseConfigured:true` 只表示服务拿到了 `DATABASE_URL`；`databaseReady:true` 才表示 `users`、`auth_sessions`、`saved_configs`、`render_jobs`、`schema_migrations` 等必需表已存在。

## 生产部署注意事项

- 生产环境必须配置模板 TOS 存储；缺配置时模板资产能力会返回可读错误。
- 生产环境必须配置生成文件 OSS/TOS 存储；不要让最终 Docx 落到本机临时目录。
- 生产环境 PostgreSQL 数据目录必须固定；部署脚本会自动写入 `POSTGRES_DATA_DIR` 并兼容旧 release 目录迁移。
- 生产 Docx API 必须配置 `DOCUMENT_RENDER_API_KEY` 或使用服务端可信会话；不能依赖 `X-Bitable-*` 作为登录凭据。
- 飞书多维表格侧边栏请求可以通过 Base JS SDK 附带 `X-Bitable-Open-Id` / `X-Bitable-Base-User-Id`、`X-Bitable-Base-Id`、`X-Bitable-Table-Id`、`X-Bitable-Tenant-Key` 作为宿主上下文线索，但这些头不授予模板创建、管理或 `private` 模板读取权限。
- `/api/auth/session` 只作为兼容诊断接口，未登录时返回稳定 JSON；`/api/auth/logout` 可清理旧会话。
- 当前可信登录入口是 Feishu client-code 和插件内扫码：`/api/auth/feishu/:appKey/client-config`、`/api/auth/feishu/:appKey/client-code`、`/auth/feishu/:appKey/qr-config`、`/auth/feishu/:appKey/qr-callback`。这些入口只写 httpOnly cookie，不返回 session token。
- 旧外部 OAuth / handoff 入口当前显式返回 410，避免被静态前端页面兜底成假 200。若未来恢复这类入口，必须重新做真实飞书侧边栏登录验收和 session 接管安全评审。
- `index.html` 响应头应为 `Cache-Control: no-cache`；带 hash 的静态资源可长期缓存。
- API 错误响应不应包含堆栈、AccessKey、bucket 名称或内部路径。
- `.env.local`、部署密钥和真实 AccessKey 不允许提交到仓库。

## 常见故障

| 现象 | 排查 |
|---|---|
| 上传模板失败，提示非 HTTPS | 确认模板下载链接是 HTTPS；本地调试才可设置 `DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS=true`。 |
| 上传模板失败，提示内网地址 | 模板链接不能指向本机、内网或云元数据地址。 |
| 生成失败，返回 `missingVariables` | 请求变量缺少模板中存在的字段，补齐后重试。 |
| 生成失败，返回 `unusedVariables` | 请求变量名和模板变量不一致，检查大小写、空格和中文名。 |
| 生产环境返回对象存储配置错误 | 检查 OSS/TOS 四件套：AccessKey、Secret、Bucket、Region。 |
| 侧边栏上传/更新模板提示登录状态没有接上 | 先检查 `/api/auth/session` 是否 `loggedIn:true`；若为 false，确认保存面板是否能展示插件内扫码登录，并检查 `/api/auth/feishu/fbif/client-config`、`/auth/feishu/fbif/qr-config`、`/auth/feishu/fbif/qr-callback`。`X-Bitable-*` 只能说明宿主上下文，不能替代登录。 |
| 模板列表看不到“仅自己”模板 | 确认当前调用方是模板创建者的可信会话、管理员或 API Key；后端会在列表、详情、版本、生成和预览路径都过滤 `private` 模板。 |
| 访问 `/auth/feishu/fbif/login` 返回 410 | 当前预期行为。旧外部 OAuth 登录入口已退役；侧边栏可信登录应走 client-code 或插件内扫码。 |
| `/api/auth/session` 返回 `loggedIn:false` | 当前请求没有服务端可信会话；这会阻塞需要用户身份的模板创建、更新和 `private` 模板读取。 |
| 异步任务查询 404 | 先确认是否使用了提交任务时同一登录用户或 API Key，再确认任务是否已过期，最后查 `DATABASE_URL` 和 `render_jobs` 表。未配置数据库的本地开发/测试环境会使用进程内存，服务重启后不会保留历史任务。 |
| 部署后登录状态或配置都像丢了 | 先检查 `.env` 里的 `POSTGRES_DATA_DIR` 是否是稳定目录，再检查 PostgreSQL 容器挂载路径。 |

## UI 验证要求

涉及 `src/components/document-generator/`、样式、布局、图标的修改，必须：

1. 启动本地服务前检查端口是否占用。
2. 用 `curl -s <url> | grep '<title>'` 确认页面属于当前项目。
3. 用真实浏览器或 Playwright 打开页面。
4. 检查桌面和移动宽度下的模板库、字段映射、按钮、空状态、错误状态。

登录相关 UI 改动还必须在飞书桌面真实侧边栏验证：点击“使用 FBIF 飞书登录”后，必须停留在当前插件面板；若当前宿主支持 H5 WebApp 授权则进入主界面，若真实 PC Lark no-WebApp 则直接显示插件内扫码登录。只验证普通页面或 Chrome 已登录不算通过。
