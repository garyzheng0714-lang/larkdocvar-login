# Project Context

更新时间：2026-05-15

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
| OAuth 回调错误 | 飞书按钮登录或扫码登录失败后，后端带 `auth_error` 重定向回前端登录页，前端展示可读错误并清理 URL 参数。 |
| 飞书客户端内登录 | 支持 H5 WebApp 容器时，前端通过 H5 JSAPI `tt.requestAuthCode` / `tt.requestAccess` 获取授权 code，再由后端 `/client-code` 换取用户 OAuth token 并创建本项目会话。真实 PC Lark 多维表格侧边栏 UA 为 `Lark/7.68.5` 且不含 `WebApp`，不是 H5 WebApp 授权容器；前端直接留在插件内切到扫码登录，不伪造 UA、不等待 native auth，也绝不自动拉起外部 OAuth。 |
| 浏览器 OAuth 登录 | 普通浏览器通过 `/auth/feishu/:appKey/login` 在当前页跳转 OAuth；`/api/auth/feishu/:appKey/start` 和 `/login-status` 的 JSON handoff 已停用，避免用已知 state 领取他人 session。 |
| 批量生成 | `POST /api/v1/document-renders/batch`，单次最多 100 条记录，每条独立成功/失败。 |
| 异步任务 | `POST /api/v1/document-render-jobs`，单任务最多 500 条记录，提交后查询进度和结果。 |

## 路由速查

| 路由 | 作用 |
|---|---|
| `GET /api/auth/feishu/:appKey/client-config` | 返回当前登录入口的飞书 `app_id`，供客户端内 JSAPI 授权使用。 |
| `POST /api/auth/feishu/:appKey/client-code` | 接收飞书客户端内授权 code，换取用户 OAuth token 并返回嵌入式会话 `session_token`。 |
| `GET /api/auth/feishu/:appKey/start` | 已停用的外部 OAuth JSON handoff，固定返回 410。 |
| `GET /api/auth/feishu/:appKey/login-status` | 已停用的外部 OAuth JSON handoff 轮询，固定返回 410。 |
| `GET /auth/feishu/:appKey/login` | 浏览器 OAuth 登录跳转，当前页跳转到飞书授权页。 |
| `GET /auth/feishu/:appKey/callback` | OAuth 登录回调，飞书授权后重定向回前端。 |
| `GET /auth/feishu/:appKey/qr-config` | 扫码登录配置，返回扫码登录所需的 app_id 和重定向 URI。 |
| `GET /auth/feishu/:appKey/qr-callback` | 扫码登录回调，飞书扫码授权后重定向回前端。 |
| `POST /api/auth/feishu/:appKey/client-diagnostics` | 客户端诊断，接收飞书客户端授权环境信息用于排查。 |
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

## 数据模型

PostgreSQL 当前由 `server/migrations/001_initial_schema.sql` 管理，服务启动时自动执行未应用 migration。

| 表 | 用途 |
|---|---|
| `users` | 飞书登录用户资料，以 `open_id` 为主键。 |
| `auth_sessions` | httpOnly 会话、OAuth token 和刷新时间。 |
| `saved_configs` | 用户保存的模板映射配置，按 `open_id + config_name` 去重。 |
| `schema_migrations` | 已执行数据库 migration 版本。 |

## 存储边界

- PostgreSQL：登录会话、用户、飞书云文档模板配置和 migration 版本。
- TOS 模板存储：Docx 模板资产的 `_index.json`、`metadata.json` 和版本源文件。
- OSS/TOS 生成文件存储：最终生成 Docx 的带有效期下载链接。
- 本地存储：仅本地开发兜底；生产环境缺模板 TOS 或生成对象存储配置时应失败，不应悄悄落本机。
- OAuth 失败路径：终端用户只能看到前端登录页错误提示，不能看到接口 JSON、堆栈或内部调试信息。

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
