# Docx API 架构说明

更新时间：2026-06-22

## 模块划分

| 模块 | 文件 | 职责 |
|---|---|---|
| 单份生成 API | `server/src/documentRenderApi.ts` | 下载或加载模板、替换变量、保存生成文件、返回下载链接。 |
| 批量生成 API | `server/src/documentRenderBatchApi.ts` | 逐条调用单份生成逻辑，单条失败不影响其他记录。 |
| 异步任务 API | `server/src/documentRenderJobApi.ts` | 提交后后台执行，维护进度和结果。 |
| 模板管理 API | `server/src/documentTemplateApi.ts` | 上传、列表、查询、版本、删除模板资产。 |
| 模板服务 | `server/src/documentTemplateService.ts` | 生成 `templateId`/`versionId`、提取变量和缩略图、维护 metadata/index。 |
| 模板对象存储 | `server/src/documentTemplateStorage.ts` | TOS 或本地开发目录读写模板资产。 |
| 输出对象存储 | `server/src/documentRenderTosStorage.ts` 和 `documentRenderApi.ts` | OSS/TOS/local 保存最终生成文件。 |
| 侧边栏 UI | `src/components/document-generator/` | 服务器 Docx 模板库管理和多维表格批量生成入口。 |
| 侧边栏身份 | `server/src/auth.ts`、`server/src/routes/authSessionRoutes.ts`、`src/authSessionToken.ts`、`src/components/document-generator/cloudDoc/bitableAdapter.ts`、`src/components/document-generator/cloudDoc/feishuTrustedLogin.ts` | 当前 Word 模板侧边栏只把 Base JS SDK 的 `X-Bitable-*` 作为宿主上下文线索；模板权限必须来自 API Key 或服务端可信会话；可信会话优先通过 Feishu client-code 免登建立，能力不可用时走一键 OAuth，扫码仅作备用；旧 handoff 入口返回 410。 |
| 数据库迁移 | `server/migrations/` + `server/src/migrations.ts` | 管理 PostgreSQL 表结构版本，启动时记录到 `schema_migrations`。 |

## 数据流

```mermaid
flowchart TD
  A["业务系统/侧边栏上传模板 URL"] --> B["POST /api/v1/document-templates"]
  B --> C["下载并校验 Docx"]
  C --> D["提取变量和缩略图并写入 metadata.json"]
  D --> E["保存 source.docx 到 TOS 模板库"]
  E --> F["返回 templateId"]
  G["生成请求携带 templateId + variables"] --> H["加载模板当前版本"]
  H --> I["替换正文/表格/页眉/页脚变量"]
  I --> J["校验缺失变量、未使用变量、残留占位符"]
  J --> K["保存最终 Docx 到 OSS/TOS/local"]
  K --> L["返回带有效期 download.url"]
```

## 数据模型

PostgreSQL schema 由 `server/migrations/` 管理，启动时通过 `server/src/migrations.ts` 执行未应用版本，并写入 `schema_migrations`。

| 表 | 关键字段 | 职责 |
|---|---|---|
| `users` | `open_id`、`name`、`email`、`avatar_url` | 保存飞书登录用户资料。 |
| `auth_sessions` | `token`、`oauth_app_key`、`open_id`、`access_token`、`refresh_token`、`expires_at` | 保存侧边栏 httpOnly 登录会话和 OAuth token。 |
| `saved_configs` | `id`、`open_id`、`config_name`、`payload_json` | 保存用户模板映射配置；同一用户同一配置名只保留一份。 |
| `render_jobs` | `job_id`、`owner_key`、`lease_owner`、`lease_expires_at`、`status`、`processed`、`succeeded`、`failed`、`records_json`、`results_json` | 保存异步 Docx 批量任务状态、进度、结果、执行租约和提交者身份绑定。 |
| `schema_migrations` | `version`、`name`、`applied_at` | 记录已执行 migration，避免重复执行 DDL。 |

## 模板资产结构

TOS 对象存储支持统一项目根目录 `DOCUMENT_TOS_ROOT_PREFIX`。生产建议按项目和环境分层，例如 `fbif-sidebar-docgen/prod`；未配置时保留历史根目录，避免影响已有对象。

```text
fbif-sidebar-docgen/
└── prod/
    ├── templates/
    │   ├── _index.json
    │   └── fbiftemp_20260512_001/
    │       ├── metadata.json
    │       └── versions/
    │           ├── v001/source.docx
    │           └── v002/source.docx
    └── renders/
        ├── 2026/05/13/req-001.docx
        └── diagnostics/2026/05/13/1747100000000-a1b2.txt
```

模板对象存储使用 `DOCUMENT_TEMPLATE_TOS_PREFIX`，推荐值为 `templates`；生成文件使用 `DOCUMENT_RENDER_TOS_PREFIX`，推荐值为 `renders`。如果没有配置 `DOCUMENT_TOS_ROOT_PREFIX`，这些前缀仍可单独作为 bucket 根目录下的一级目录使用。

`metadata.json` 保存模板内部记录，包括原始 `sourceUrl`、变量列表和缩略图结构，只供服务端使用。公开 API 响应会移除 `sourceUrl`。

`_index.json` 是列表接口的轻量索引，包含 `templateId`、名称、状态、当前版本、版本数、变量列表、当前版本缩略图、创建/更新时间。

## API 契约优先

Docx API 是本项目底层契约。新增能力必须先更新 `docs/docx-api-integration.md`，并在文档开头的「更新日志」表格追加记录，再实现后端 API 和侧边栏消费逻辑。

侧边栏、脚本和其它工具都只能消费 API 暴露的稳定字段。模板缩略图这类核心能力应由模板 API 返回 `thumbnail`，不能只在前端按模板 ID 或模板名称临时生成占位图。

## 版本策略

- 新模板的首个版本为 `${templateId}_v001`。
- `POST /api/v1/document-templates/:templateId/versions` 会追加新版本并设为当前版本。
- 生成请求不传 `versionId` 时使用 `activeVersionId`。
- 软删除后模板不能继续生成；`purge=true` 会删除 metadata 和版本对象。

## 生成策略

Docx 替换逻辑会处理：

- `word/document.xml`
- 表格内文本
- 页眉、页脚
- 脚注等 `word/*.xml` 相关部件
- Word 把 `{{变量}}` 拆成多个文本节点的情况

替换后会检查：

- 模板中出现但请求未提供的变量，返回 `missingVariables`。
- 请求提供但模板中未出现的变量，返回 `unusedVariables`。
- 输出文件仍残留 `{{变量}}`，拒绝生成半成品。
- zip bomb、伪装 Docx、坏 Docx、超 20MB 模板。

## 存储策略

| 对象 | 开发环境 | 生产环境 |
|---|---|---|
| 模板资产 | 无 TOS 时可落本地目录 | 必须配置 TOS，否则拒绝启动相关能力 |
| 生成文件 | 无 OSS/TOS 时可 local 降级 | 必须配置 OSS 或 TOS，不允许 local 降级 |
| PostgreSQL 数据 | 未设置 `POSTGRES_DATA_DIR` 时使用 Docker named volume | 部署脚本固定到 `{APP_DIR}/data/postgres`，不能跟随 release 目录 |

TOS 同时可用于模板资产和生成文件；生成文件也支持阿里云 OSS。

PostgreSQL 表结构通过 `server/migrations/` 管理，服务启动时执行未应用版本并写入 `schema_migrations`。生产部署前应先确认数据库备份可恢复。

## 侧边栏身份链路

飞书多维表格 iframe 内的请求先继续携带 cookie。Base JS SDK 提供的 `X-Bitable-*` 只能作为宿主 Base/Table/Tenant 和用户线索，不能单独作为认证凭据：

```mermaid
sequenceDiagram
  participant Iframe as "飞书侧边栏 iframe"
  participant SDK as "Base JS SDK"
  participant Server as "Docgen 服务端"
  Iframe->>SDK: "getSelection / getUserId / getBaseUserId / getTenantKey"
  SDK-->>Iframe: "baseId / tableId / openId 或 baseUserId / tenantKey"
  Iframe->>Server: "同源请求 + credentials + X-Bitable-*"
  Server->>Server: "只把 X-Bitable-* 作为上下文线索"
  Server->>Server: "用 API Key 或可信 session 判定模板权限"
  Server-->>Iframe: "模板列表/保存/生成响应"
```

`/api/auth/session` 保留为兼容诊断接口，未登录时返回稳定 JSON，已登录时也不返回飞书 `access_token`。侧边栏入口会先检查可信会话，再尝试 Feishu client-code 端内免登；当前宿主不支持 H5 WebApp 授权时，界面展示“使用 FBIF 飞书登录”按钮，走 `/auth/feishu/:appKey/login` 当前页 OAuth。OAuth state 是签名自包含数据，回调即使没有 state cookie 也能校验；登录成功后同时写 httpOnly cookie，并通过 URL hash 给嵌入式侧边栏传递会话兜底。端内免登的 JSON 响应体不返回会话 token，但同源响应头可返回 `X-Session-Token`，前端会立即存储并在后续同源请求里继续带该头。扫码登录只作为用户主动选择的备用入口。旧 `/api/auth/feishu/:appKey/start`、`/login-status` handoff 子路径继续返回 410，避免重新引入 session 接管风险；query token 已移除，避免 token 出现在 URL、日志或分享链路里。

## 安全边界

- 生产 Docx API 必须使用 API Key 或服务端可信会话；不能匿名放行。
- `X-Bitable-*` 只作为客户端上下文线索，不绑定模板创建者，不授予 `private` 模板读取权。
- `private/shared` 可见范围覆盖模板列表、详情、版本、单份生成、同步批量、异步任务和 PDF 预览。
- 默认禁止模板链接访问本机、内网、云元数据地址。
- 默认禁止非 HTTPS 模板链接。
- 错误响应只返回用户可理解原因，不暴露内部堆栈。
- 受跟踪密钥扫描覆盖 OSS/TOS 关键变量，报告只输出变量名和文件路径。

## 已知实现边界

- 异步任务在配置 `DATABASE_URL` 时写入 PostgreSQL `render_jobs` 表，并按提交时的登录用户或 API Key 绑定查询权限；未配置数据库的本地开发/测试环境会降级为进程内存。运行中的任务会刷新 `lease_expires_at`，服务启动只会失败租约过期的未完成任务，避免多实例误杀。
- PDF 预览是按需能力：只有请求 `output.includePdfPreview=true` 且服务端配置 `GOTENBERG_URL` 时，才会把生成后的 Docx 交给 Gotenberg/LibreOffice 转成 PDF 预览。
- 侧边栏当前已拆到 `src/components/document-generator/`，但 `PrimaryScreen.tsx` 和 `_design.css` 仍偏大。继续扩展前端时应优先按模板库、字段映射、生成进度等边界拆分。
