# Project Context

更新时间：2026-06-22

## 产品边界

本项目同时提供两条文档生成路径：

- 飞书云文档模板路径：侧边栏读取飞书云文档里的 `{{变量}}`，按多维表格字段批量生成飞书云文档，并把链接写回表格。
- Docx 模板资产路径：业务系统或侧边栏先上传 `.docx` 模板下载链接，服务端把模板永久保存为 `templateId` 对应的资产，后续生成只传 `templateId` 和变量，返回可下载的最终 Docx。

两条路径不要混淆。飞书云文档模板依赖登录用户 OAuth 权限；Docx 模板资产依赖 `/api/v1/document-templates` 和对象存储。

## 关键术语

| 术语 | 含义 |
|---|---|
| `templateId` | 服务端定义的模板编号，例如 `fbiftemp_20260512_001`。业务系统后续生成应优先传这个编号。 |
| `versionId` | 模板版本编号，格式为 `${templateId}_v001`、`${templateId}_v002`。不传时使用模板当前激活版本。 |
| 模板资产 | 原始 Docx 模板文件及其 metadata/index，存放在 TOS 或本地开发目录。生产环境必须配置 TOS 模板存储。 |
| 生成文件 | 变量替换后的最终 Docx，存放在 OSS/TOS；本地开发无对象存储时可降级 local。 |
| 可信会话 | 服务端通过 httpOnly cookie、`X-Session-Token` 或 Bearer 解析出的本项目会话。`X-Bitable-*` 只作宿主上下文线索，不等同可信会话。 |
| 可信登录入口 | `/api/auth/feishu/:appKey/client-config`、`/api/auth/feishu/:appKey/client-code` 和 `/auth/feishu/:appKey/qr-*` 可建立服务端可信会话；响应只写 httpOnly cookie，不向前端返回 session token。 |
| 退役 OAuth 入口 | 外部浏览器 OAuth、handoff 轮询和未知 Feishu auth 子路径返回 410，避免旧登录入口被 SPA 兜底成假 200 或重新引入 session 接管风险。 |
| API Key | 生产 Docx API 必须使用 `DOCUMENT_RENDER_API_KEY` 或可信会话；业务系统用 `Authorization: Bearer` 或 `x-api-key`。 |
| 批量生成 | `POST /api/v1/document-renders/batch`，单次最多 100 条记录，每条独立成功/失败。 |
| 异步任务 | `POST /api/v1/document-render-jobs`，单任务最多 500 条记录，提交后查询进度和结果；配置 `DATABASE_URL` 时任务状态写入 PostgreSQL，并按提交身份绑定查询权限。 |

## 路由速查

| 路由 | 作用 |
|---|---|
| `GET /api/auth/session` | 兼容诊断接口，返回登录状态；不会返回 session token。 |
| `POST /api/auth/logout` | 清理兼容会话 cookie / token；无会话也返回成功。 |
| `GET /api/auth/feishu/:appKey/client-config` | 返回飞书端内授权所需 app_id；不返回 app_secret 或 session token。 |
| `POST /api/auth/feishu/:appKey/client-code` | 使用飞书客户端授权 code 换取真实用户 OAuth token，写入服务端可信会话 cookie。 |
| `GET /auth/feishu/:appKey/qr-config` | 返回插件内扫码登录二维码 goto；不返回 session token。 |
| `GET /auth/feishu/:appKey/qr-callback` | 扫码授权回调，校验 state 后写入服务端可信会话 cookie。 |
| 其它 `/auth/feishu/*`、`/api/auth/feishu/*` | 旧 OAuth / handoff 入口返回 410。 |
| `POST /api/v1/document-templates` | 上传并保存 Docx 模板资产，返回 `templateId`。 |
| `GET /api/v1/document-templates` | 列出模板资产；`includeDeleted=true` 可包含软删除模板。 |
| `GET /api/v1/document-templates/:templateId` | 查询单个模板详情。 |
| `GET /api/v1/document-templates/:templateId/versions` | 查询模板的版本列表。 |
| `POST /api/v1/document-templates/:templateId/versions` | 为已有模板新增版本并设为当前版本。 |
| `DELETE /api/v1/document-templates/:templateId` | 软删除模板；`purge=true` 会删除对象存储里的模板对象。 |
| `POST /api/v1/document-renders` | 单份 Doc/Docx 生成。Docx 支持 `template.url` 或 `template.templateId`。 |
| `GET /api/v1/document-renders/downloads/:id` | local 开发存储的临时下载地址；客户端只使用 API 返回的 `download.url`，不要手写拼接。 |
| `POST /api/v1/document-renders/batch` | 同步批量生成，最多 100 条。 |
| `POST /api/v1/document-render-jobs` | 提交异步批量任务，最多 500 条。 |
| `GET /api/v1/document-render-jobs/:jobId` | 查询异步任务进度。 |
| `GET /api/v1/document-render-jobs/:jobId/results` | 查询异步任务最终结果。 |

## 鉴权与模板可见范围

- 生产环境 Docx API 不匿名放行；必须有 API Key 或可信会话。
- `X-Bitable-*` 来自客户端，只能作为宿主上下文线索，不绑定模板创建者，不授予 `private` 模板读取权。
- `private` 模板只允许创建者、管理员或 API Key 调用方读取；这个规则覆盖模板列表、详情、版本、单份生成、同步批量、异步任务和 PDF 预览。
- `shared` 模板对已通过 API Key/可信会话访问的调用方可见；本地开发未启用鉴权时可匿名读取。

## 数据模型

PostgreSQL 当前由 `server/migrations/` 管理，服务启动时自动执行未应用 migration。

| 表 | 用途 |
|---|---|
| `users` | 飞书登录用户资料，以 `open_id` 为主键。 |
| `auth_sessions` | httpOnly 会话、OAuth token 和刷新时间。 |
| `saved_configs` | 用户保存的模板映射配置，按 `open_id + config_name` 去重。 |
| `render_jobs` | 异步 Docx 批量生成任务状态、进度、结果和提交者身份绑定。 |
| `schema_migrations` | 已执行数据库 migration 版本。 |

## 存储边界

- PostgreSQL：登录会话、用户、飞书云文档模板配置、异步生成任务和 migration 版本。
- TOS 模板存储：Docx 模板资产的 `_index.json`、`metadata.json` 和版本源文件。
- OSS/TOS 生成文件存储：最终生成 Docx 的带有效期下载链接；local/OSS/TOS provider 选择集中在 `server/src/documentRenderStorage.ts`。
- 本地存储：仅本地开发兜底；生产环境缺模板 TOS 或生成对象存储配置时应失败，不应悄悄落本机。
- OAuth 失败路径：终端用户只能看到前端登录页错误提示，不能看到接口 JSON、堆栈或内部调试信息。

## 可维护性边界

- `server/src/documentRenderApi.ts` 保持在 900 行以内，聚焦请求校验、渲染和路由；存储 provider 细节不要回流到该文件。
- 侧边栏 Word 主屏拆为 `PrimaryScreen.tsx` 与 `PrimaryScreenParts.tsx`；新增字段行、文件命名、写回字段等局部 UI 时优先落在 parts 文件。
- 批量开始生成和重试失败共享 `useBatchRunner.ts` 的分片执行循环；不要复制暂停/终止轮询逻辑。

## 核心验证

常用交付前验证：

```bash
npm test
npm run build
npm run verify:secrets
git diff --check
```

Docx 里程碑完整验收：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:document-render-milestone1
npm run audit:document-render-milestone1
```

前端 UI 改动必须用真实浏览器或 Playwright 检查侧边栏页面，不能只依赖 `tsc` 或构建通过。
