# Project Context

更新时间：2026-05-12

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
| 批量生成 | `POST /api/v1/document-renders/batch`，单次最多 100 条记录，每条独立成功/失败。 |
| 异步任务 | `POST /api/v1/document-render-jobs`，单任务最多 500 条记录，提交后查询进度和结果。 |

## 路由速查

| 路由 | 作用 |
|---|---|
| `POST /api/v1/document-templates` | 上传并保存 Docx 模板资产，返回 `templateId`。 |
| `GET /api/v1/document-templates` | 列出模板资产；`includeDeleted=true` 可包含软删除模板。 |
| `GET /api/v1/document-templates/:templateId` | 查询单个模板详情。 |
| `POST /api/v1/document-templates/:templateId/versions` | 为已有模板新增版本并设为当前版本。 |
| `DELETE /api/v1/document-templates/:templateId` | 软删除模板；`purge=true` 会删除对象存储里的模板对象。 |
| `POST /api/v1/document-renders` | 单份 Doc/Docx 生成。Docx 支持 `template.url` 或 `template.templateId`。 |
| `POST /api/v1/document-renders/batch` | 同步批量生成，最多 100 条。 |
| `POST /api/v1/document-render-jobs` | 提交异步批量任务，最多 500 条。 |
| `GET /api/v1/document-render-jobs/:jobId` | 查询异步任务进度。 |
| `GET /api/v1/document-render-jobs/:jobId/results` | 查询异步任务最终结果。 |

## 存储边界

- PostgreSQL：登录会话、用户、飞书云文档模板配置。
- TOS 模板存储：Docx 模板资产的 `_index.json`、`metadata.json` 和版本源文件。
- OSS/TOS 生成文件存储：最终生成 Docx 的带有效期下载链接。
- 本地存储：仅本地开发兜底；生产环境缺模板 TOS 或生成对象存储配置时应失败，不应悄悄落本机。

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
