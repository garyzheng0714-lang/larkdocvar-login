# Docx API 参考文档

最后更新：2026-06-22

## 更新日志

| 日期 | 类型 | 变更内容 | API 影响 | 飞书云文档 |
|---|---|---|---|---|
| 2026-06-22 | 契约调整 | 未指定 `templateId` 时，服务端自动生成简短递增模板编号。 | 自动模板编号从历史日期随机格式调整为 `tpl_001`、`tpl_002` 这类递增编号；手动传入的合法 `templateId` 仍兼容。 | 已同步 |
| 2026-06-02 | 维护性 | 拆分 Docx 生成存储边界到 `documentRenderStorage.ts`；`documentRenderApi.ts` 回到 900 行以内；侧边栏主屏拆分组件并清理旧 CSS；批量开始生成和重试路径共用 `runBatchSlices`。 | 路由和请求响应字段不变；`createConfiguredStorage`、`DocumentRenderStorage` 等兼容导出保留。 | 已同步 |
| 2026-06-02 | 契约新增 | 新增 `missingStrategy=blank` 留空继续契约；新增 `output.includePdfPreview` Gotenberg PDF 预览。 | 文本变量缺失可按空字符串生成，响应仍返回 `variables.missing`；请求 PDF 预览时需配置 `GOTENBERG_URL`。 | 已同步 |
| 2026-05-31 | 修复澄清 | 修复图片变量请求键前缀兼容、同步批量模板预加载错误 JSON 响应、异步任务 PostgreSQL 持久化、租约和任务读取身份绑定说明。 | 图片变量请求键兼容 `logo`、`image:logo`、`图片:logo`；异步任务配置 `DATABASE_URL` 时写入 `render_jobs`，并按提交时的登录用户或 API Key 绑定查询权限；未完成任务仅在执行租约过期后标记失败。 | 已同步 |
| 2026-05-13 | 字段补齐 | 补齐模板 `fileBase64` 上传、模板元数据、下载对象和 `output.includeFileBase64` 说明。 | 文档补齐现有请求/响应字段，不新增路由。 | 已同步 |
| 2026-05-13 | 存储约定 | 新增 TOS 统一根目录 `DOCUMENT_TOS_ROOT_PREFIX`；TOS 生成文件按 `YYYY/MM/DD` 分层，模板与生成文件推荐分到 `templates`、`renders`。 | 不新增响应字段；`storagePath` 和 `download.path` 会反映实际对象 key。 | 已同步 |
| 2026-05-13 | 契约新增 | 明确 API 文档优先原则；新增模板缩略图响应字段契约。 | 模板列表、模板详情和模板版本响应新增 `thumbnail`。 | 已同步 |
| 2026-05-12 | 初版 | 建立 Docx API 接入文档，覆盖模板管理、文档生成、同步批量和异步任务。 | 定义 `/api/v1/document-templates`、`/api/v1/document-renders`、`/api/v1/document-render-jobs` 等接口。 | 已发布 |

面向接入方的飞书云文档版：[Docx API 接入文档](https://foodtalks.feishu.cn/docx/GMc4diq86oTS9SxQ8txcDPYenZ2)。本文是仓库内版本，用于开发、交接和排查。

本文按飞书开放平台 API 文档的阅读结构组织：先给全局约定，再按接口逐个说明「请求、请求头、请求参数、请求示例、响应、错误处理」。接入方不需要通读全文，按接口路径查即可。

## API 优先原则

Docx API 是本项目的底层契约。新增能力必须先维护本文档和后端 API，再接入侧边栏、脚本或其它工具。侧边栏工具只消费 API 响应，不把核心能力只做在前端临时状态里。

文档同步规则：

- 每次新增、删除或改变 API 字段、路由、错误码、鉴权、存储策略时，先更新本文档。
- 本文档最前面必须维护「更新日志」表格，每次 API 文档更新都新增一行。
- 本地 Markdown 更新后，必须同步到线上飞书云文档。
- 真实密钥只能放 GitHub Actions Secrets、部署平台密钥或本地未提交的 `.env.local`，不得写入仓库文档、README 示例、日志或飞书云文档正文。

## 维护边界

Docx 渲染路由和存储实现已拆分：

- `server/src/documentRenderApi.ts`：请求校验、模板下载安全检查、Doc/Docx 渲染、响应组装和 Express 路由。
- `server/src/documentRenderStorage.ts`：local/OSS/TOS 生成文件存储选择、下载链接登记和对象存储配置读取。
- `server/src/documentRenderTosStorage.ts`：TOS V4 签名、上传和预签名下载链接。

新增对象存储能力时优先扩展存储模块，不要把 provider 细节重新写回路由文件。前端侧边栏的主屏 UI 拆在 `PrimaryScreen.tsx` 与 `PrimaryScreenParts.tsx`，批量分片循环统一走 `useBatchRunner.ts`。

## 本文内容

- 接入流程
- 公共约定
- 对象存储路径
- 模板缩略图
- 模板管理 API
- 文档生成 API
- 批量任务 API
- 变量与图片变量
- 错误处理
- 上线检查清单

## 接入流程

推荐流程：

1. 调用 `POST /api/v1/document-templates` 上传 `.docx` 模板下载链接，保存返回的 `template.templateId`。
2. 调用 `POST /api/v1/document-renders`，传 `templateId` 和变量，获取 `download.url`。
3. 模板变更时调用 `POST /api/v1/document-templates/{templateId}/versions` 新增版本，不覆盖旧版本。

不推荐每次生成时都传原始模板链接。模板链接可能过期，也会让每次生成都重新下载模板。

## 公共约定

### 基础信息

| 项目 | 说明 |
|---|---|
| Base URL | 由部署环境决定，本地默认 `http://localhost:3000`。 |
| 请求格式 | JSON。除下载文件外，建议统一传 `Content-Type: application/json`。 |
| 成功标记 | 响应体包含 `ok: true`。 |
| 失败标记 | 响应体包含 `ok: false` 和可展示给用户的 `error`。 |
| 请求追踪 | 可传 `x-request-id`；服务端会在响应中返回 `requestId`。不传时服务端自动生成。 |
| 下载链接 | `download.url` 是带有效期的临时链接，不要长期保存为永久文件地址。 |

### 对象存储路径

TOS 可用 `DOCUMENT_TOS_ROOT_PREFIX` 设置统一根目录。生产推荐按项目和环境分层，例如 `fbif-sidebar-docgen/prod`，再把模板资产和生成文件分开：

```text
fbif-sidebar-docgen/prod/
├── templates/_index.json
├── templates/{templateId}/metadata.json
├── templates/{templateId}/versions/v001/source.docx
├── renders/YYYY/MM/DD/{requestId}.docx
└── renders/diagnostics/YYYY/MM/DD/{timestamp}.txt
```

推荐配置：

```bash
DOCUMENT_TOS_ROOT_PREFIX=fbif-sidebar-docgen/prod
DOCUMENT_TEMPLATE_TOS_PREFIX=templates
DOCUMENT_RENDER_TOS_PREFIX=renders
```

如果不配置 `DOCUMENT_TOS_ROOT_PREFIX`，系统继续使用历史根目录前缀，例如 `document-templates/...` 和 `document-renders/...`。API 响应里的 `storagePath`、`download.path` 都是实际写入对象存储的 key，接入方不要手写拼接。

### 下载对象

单份生成、同步批量生成成功记录、异步任务结果成功记录都会返回 `download` 对象。

| 名称 | 类型 | 描述 |
|---|---|---|
| `download.url` | string | 带有效期的下载链接。OSS/TOS 为签名 URL；local 为同源 `/api/v1/document-renders/downloads/{id}`。 |
| `download.path` | string | 实际对象 key 或 local 下载路径。仅用于排查和审计，不要手写拼接。 |
| `download.fileName` | string | 下载文件名，服务端会确保 `.docx` 后缀。 |
| `download.contentType` | string | 固定为标准 Docx MIME。 |
| `download.size` | number | 文件字节数。 |
| `download.storage` | string | `local`、`oss` 或 `tos`。生产环境应为 `oss` 或 `tos`。 |
| `download.createdAt` | string | 文件生成时间。 |
| `download.expiresAt` | string | 下载链接失效时间。 |
| `download.fileBase64` | string | 仅请求 `output.includeFileBase64=true` 时返回，用于侧边栏把生成文件写回附件字段；业务系统不应长期保存。 |

### 认证

如果服务端配置了 `DOCUMENT_RENDER_API_KEY`，业务系统必须传以下任一种请求头。

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `Authorization` | string | 二选一 | 格式为 `Bearer <api-key>`。 |
| `x-api-key` | string | 二选一 | 直接传 API Key。 |

已登录的侧边栏用户可以通过登录会话调用同一组接口。业务系统不要依赖侧边栏登录态，应使用 API Key。

### 通用错误响应

```json
{
  "ok": false,
  "requestId": "req-001",
  "error": "请求参数不合法。"
}
```

## 接口目录

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/v1/document-templates` | 1. 上传模板。 |
| `GET` | `/api/v1/document-templates` | 2. 查询模板列表。 |
| `GET` | `/api/v1/document-templates/{templateId}` | 3. 查询模板详情。 |
| `GET` | `/api/v1/document-templates/{templateId}/versions` | 4. 查询模板版本。 |
| `POST` | `/api/v1/document-templates/{templateId}/versions` | 5. 新增模板版本。 |
| `DELETE` | `/api/v1/document-templates/{templateId}` | 6. 删除模板。 |
| `POST` | `/api/v1/document-renders` | 7. 生成单份文档。 |
| `GET` | `/api/v1/document-renders/downloads/{id}` | local 开发存储的临时下载地址；客户端只使用 `download.url`。 |
| `POST` | `/api/v1/document-renders/batch` | 8. 同步批量生成。 |
| `POST` | `/api/v1/document-render-jobs` | 9. 提交异步批量任务。 |
| `GET` | `/api/v1/document-render-jobs/{jobId}` | 10. 查询异步任务进度。 |
| `GET` | `/api/v1/document-render-jobs/{jobId}/results` | 11. 查询异步任务结果。 |

## 模板缩略图

模板 API 会在模板创建和新增版本时，从当前 `.docx` 模板中提取一个轻量缩略图结构。前端模板列表、模板详情弹层和其它工具应直接消费该字段渲染粗略预览，不应在前端按模板 ID 随机生成占位图。

缩略图不是完整 Word 渲染结果，只用于帮助用户在模板库里快速识别模板。它必须满足：

- 基于模板正文真实文本生成。
- 不暴露 `{{变量}}`、XML、Markdown 或其它存储格式字面量。
- 列表接口返回当前启用版本的缩略图。
- 详情和版本接口返回每个版本各自的缩略图。

### 字段结构

| 名称 | 类型 | 描述 |
|---|---|---|
| `thumbnail.kind` | string | 固定值：`docx-outline`。表示由 Docx 结构提取的近似纸张缩略图。 |
| `thumbnail.pageRatio` | number | 页面高宽比，默认 `1.414`，前端可按 A4 纸张比例渲染。 |
| `thumbnail.lines[]` | array | 预览文本行，最多返回 8 行。 |
| `thumbnail.lines[].text` | string | 已去除存储格式的可展示文本。变量占位符会显示为变量名本身，不带大括号。 |
| `thumbnail.lines[].role` | string | `title` 或 `body`。前端可用不同线条宽度/粗细表达层级。 |
| `thumbnail.variableNames[]` | string[] | 当前版本识别到的文本变量名，最多返回 6 个用于缩略图点缀。 |
| `thumbnail.hasImagePlaceholders` | boolean | 是否包含图片类占位符。 |

### 示例

```json
{
  "kind": "docx-outline",
  "pageRatio": 1.414,
  "lines": [
    { "text": "离职证明", "role": "title" },
    { "text": "兹证明 员工姓名 于 入职日期 入职我司。", "role": "body" },
    { "text": "离职日期 后双方劳动关系解除。", "role": "body" }
  ],
  "variableNames": ["员工姓名", "入职日期", "离职日期"],
  "hasImagePlaceholders": false
}
```

## 1. 上传模板

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates` |
| HTTP Method | `POST` |
| 适用场景 | 首次保存一个 `.docx` 模板资产。 |
| 生产环境要求 | 模板资产存储必须配置 TOS。 |

### 请求头

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `Content-Type` | string | 是 | 固定值：`application/json`。 |
| `Authorization` / `x-api-key` | string | 取决于配置 | 服务端配置 `DOCUMENT_RENDER_API_KEY` 时必填。 |
| `x-request-id` | string | 否 | 便于业务系统串联日志，最长按 128 字符处理。 |

### 请求体

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `templateId` | string | 否 | 自定义模板编号。只能包含字母、数字、下划线和中划线，长度 3 到 80。不传时服务端自动生成 `tpl_001`、`tpl_002` 这类递增编号。 |
| `name` | string | 否 | 模板名称，最多 255 字符。未传时从文件名或模板编号推断。 |
| `url` | string | 二选一 | Docx 模板下载链接。生产环境默认要求 HTTPS，且不能指向内网、本机或云元数据地址。 |
| `fileBase64` | string | 二选一 | Docx 文件 Base64 内容，可带 `data:` 前缀。适合侧边栏直接上传本地文件。 |
| `fileName` | string | 否 | 原始模板文件名，最多 255 字符。服务端会自动补 `.docx`。 |
| `category` | string | 否 | 模板分类，最多 64 字符。 |
| `visibility` | string | 否 | `private` 或 `shared`。未传时按默认模板可见性处理。 |
| `description` | string | 否 | 模板说明，最多 1000 字符。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-templates \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{
    "templateId": "fbiftemp_20260512_001",
    "name": "通用合同模板",
    "url": "https://example.com/templates/contract.docx",
    "fileName": "通用合同模板.docx"
  }'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `ok` | boolean | 固定为 `true`。 |
| `requestId` | string | 请求追踪 ID。 |
| `template.templateId` | string | 模板编号，生成文档时优先使用。 |
| `template.name` | string | 模板名称。 |
| `template.category` | string | 模板分类。未设置时可能不存在。 |
| `template.visibility` | string | `private` 或 `shared`。未设置时可能不存在。 |
| `template.description` | string | 模板说明。未设置时可能不存在。 |
| `template.createdByOpenId` | string | 创建者 open_id。匿名或旧数据可能不存在。 |
| `template.updatedByOpenId` | string | 最后更新者 open_id。匿名或旧数据可能不存在。 |
| `template.status` | string | `active` 或 `deleted`。 |
| `template.activeVersionId` | string | 当前启用版本。 |
| `template.versions[]` | array | 模板版本列表。公开响应不会返回原始 `sourceUrl`。 |
| `template.versions[].storagePath` | string | 模板源文件在对象存储中的 key 或本地开发路径。 |
| `template.versions[].fileName` | string | 模板源文件名。 |
| `template.versions[].sha256` | string | 模板源文件 SHA-256。 |
| `template.versions[].size` | number | 模板源文件字节数。 |
| `template.versions[].variables` | string[] | 服务端从模板中提取出的变量名。 |
| `template.versions[].thumbnail` | object | 服务端从该版本模板中提取出的缩略图。字段结构见「模板缩略图」。 |
| `template.versions[].createdAt` | string | 版本创建时间。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "template": {
    "templateId": "fbiftemp_20260512_001",
    "name": "通用合同模板",
    "status": "active",
    "activeVersionId": "fbiftemp_20260512_001_v001",
    "versions": [
      {
        "versionId": "fbiftemp_20260512_001_v001",
        "versionNumber": 1,
        "storagePath": "fbif-sidebar-docgen/prod/templates/fbiftemp_20260512_001/versions/v001/source.docx",
        "fileName": "通用合同模板.docx",
        "sha256": "64f4...",
        "size": 12345,
        "variables": ["客户名称", "金额"],
        "thumbnail": {
          "kind": "docx-outline",
          "pageRatio": 1.414,
          "lines": [
            { "text": "通用合同模板", "role": "title" },
            { "text": "客户：客户名称", "role": "body" },
            { "text": "金额：金额", "role": "body" }
          ],
          "variableNames": ["客户名称", "金额"],
          "hasImagePlaceholders": false
        },
        "createdAt": "2026-05-12T00:00:00.000Z"
      }
    ],
    "createdAt": "2026-05-12T00:00:00.000Z",
    "updatedAt": "2026-05-12T00:00:00.000Z"
  }
}
```

### 常见错误

| HTTP 状态码 | 错误信息 | 排查建议 |
|---|---|---|
| `400` | `请求参数不合法。` | 检查 `url` / `fileBase64` 是否至少提供一个，字段类型是否正确。 |
| `400` | `模板编号只能包含字母、数字、下划线和中划线，长度 3 到 80。` | 修正 `templateId`。 |
| `400` | `模板编号已存在，请换一个编号或新增版本。` | 换新编号，或调用新增版本接口。 |
| `400` | 模板链接相关错误 | 检查链接是否 HTTPS、是否可公网访问、是否指向内网。 |

## 2. 查询模板列表

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates` |
| HTTP Method | `GET` |
| 适用场景 | 获取模板库列表。 |

### 查询参数

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `includeDeleted` | boolean | 否 | `true` 表示包含已软删除模板。默认只返回 `active` 模板。 |

### 请求示例

```bash
curl -s 'http://localhost:3000/api/v1/document-templates?includeDeleted=true' \
  -H 'Authorization: Bearer <api-key>'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `templates[]` | array | 模板索引列表，按 `updatedAt` 倒序排列。 |
| `templates[].templateId` | string | 模板编号。 |
| `templates[].name` | string | 模板名称。 |
| `templates[].category` | string | 模板分类。未设置时可能不存在。 |
| `templates[].visibility` | string | `private` 或 `shared`。未设置时可能不存在。 |
| `templates[].description` | string | 模板说明。未设置时可能不存在。 |
| `templates[].createdByOpenId` | string | 创建者 open_id。匿名或旧数据可能不存在。 |
| `templates[].updatedByOpenId` | string | 最后更新者 open_id。匿名或旧数据可能不存在。 |
| `templates[].status` | string | `active` 或 `deleted`。 |
| `templates[].activeVersionId` | string | 当前启用版本。 |
| `templates[].versionCount` | number | 版本数量。 |
| `templates[].variables` | string[] | 当前启用版本中的变量名。 |
| `templates[].thumbnail` | object | 当前启用版本的缩略图。字段结构见「模板缩略图」。 |
| `templates[].createdAt` | string | 模板创建时间。 |
| `templates[].updatedAt` | string | 模板更新时间。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "templates": [
    {
      "templateId": "fbiftemp_20260512_001",
      "name": "通用合同模板",
      "status": "active",
      "activeVersionId": "fbiftemp_20260512_001_v001",
      "versionCount": 1,
      "variables": ["客户名称", "金额"],
      "thumbnail": {
        "kind": "docx-outline",
        "pageRatio": 1.414,
        "lines": [
          { "text": "通用合同模板", "role": "title" },
          { "text": "客户：客户名称", "role": "body" },
          { "text": "金额：金额", "role": "body" }
        ],
        "variableNames": ["客户名称", "金额"],
        "hasImagePlaceholders": false
      },
      "createdAt": "2026-05-12T00:00:00.000Z",
      "updatedAt": "2026-05-12T00:00:00.000Z"
    }
  ]
}
```

## 3. 查询模板详情

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates/{templateId}` |
| HTTP Method | `GET` |
| 适用场景 | 查看单个模板的状态、当前版本和历史版本。 |

### 路径参数

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `templateId` | string | 是 | 模板编号。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-templates/fbiftemp_20260512_001 \
  -H 'Authorization: Bearer <api-key>'
```

### 响应体

响应结构同「上传模板」的 `template` 字段。

### 常见错误

| HTTP 状态码 | 错误信息 | 排查建议 |
|---|---|---|
| `400` | `模板不存在。` | 检查 `templateId` 是否正确，或是否已被物理删除。 |

## 4. 查询模板版本

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates/{templateId}/versions` |
| HTTP Method | `GET` |
| 适用场景 | 只需要版本列表，不需要完整模板详情。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-templates/fbiftemp_20260512_001/versions \
  -H 'Authorization: Bearer <api-key>'
```

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "templateId": "fbiftemp_20260512_001",
  "activeVersionId": "fbiftemp_20260512_001_v002",
  "versions": [
    {
      "versionId": "fbiftemp_20260512_001_v001",
      "versionNumber": 1,
      "fileName": "通用合同模板.docx",
      "sha256": "64f4...",
      "size": 12345,
      "variables": ["客户名称", "金额"],
      "thumbnail": {
        "kind": "docx-outline",
        "pageRatio": 1.414,
        "lines": [
          { "text": "通用合同模板", "role": "title" },
          { "text": "客户：客户名称", "role": "body" },
          { "text": "金额：金额", "role": "body" }
        ],
        "variableNames": ["客户名称", "金额"],
        "hasImagePlaceholders": false
      },
      "createdAt": "2026-05-12T00:00:00.000Z"
    }
  ]
}
```

## 5. 新增模板版本

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates/{templateId}/versions` |
| HTTP Method | `POST` |
| 适用场景 | 模板文件改版后追加版本，并自动设为当前启用版本。 |

### 请求体

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `name` | string | 否 | 传入后会更新模板名称。 |
| `url` | string | 二选一 | 新版本 Docx 下载链接。 |
| `fileBase64` | string | 二选一 | 新版本 Docx 文件 Base64 内容，可带 `data:` 前缀。 |
| `fileName` | string | 否 | 新版本文件名。 |
| `category` | string | 否 | 传入后会更新模板分类。 |
| `visibility` | string | 否 | 传入后会更新模板可见性，值为 `private` 或 `shared`。 |
| `description` | string | 否 | 传入后会更新模板说明；传空字符串会清空说明。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-templates/fbiftemp_20260512_001/versions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{
    "url": "https://example.com/templates/contract-v2.docx",
    "fileName": "通用合同模板-v2.docx"
  }'
```

### 响应体

响应结构同「上传模板」。新版本会出现在 `template.versions[]` 末尾，`template.activeVersionId` 指向新版本。

### 常见错误

| HTTP 状态码 | 错误信息 | 排查建议 |
|---|---|---|
| `400` | `模板不存在。` | 检查 `templateId`。 |
| `400` | `模板已删除，不能新增版本。` | 恢复或重新上传模板。 |

## 6. 删除模板

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-templates/{templateId}` |
| HTTP Method | `DELETE` |
| 适用场景 | 停用模板，或彻底清理模板对象。 |

### 查询参数

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `purge` | boolean | 否 | `true` 表示物理删除 metadata 和版本对象；默认是软删除。 |

### 请求示例

```bash
curl -s -X DELETE http://localhost:3000/api/v1/document-templates/fbiftemp_20260512_001 \
  -H 'Authorization: Bearer <api-key>'
```

物理删除：

```bash
curl -s -X DELETE 'http://localhost:3000/api/v1/document-templates/fbiftemp_20260512_001?purge=true' \
  -H 'Authorization: Bearer <api-key>'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `template.status` | string | 删除后返回 `deleted`。 |
| `template.deletedAt` | string | 删除时间。 |

### 注意事项

软删除后模板不能继续生成，但 metadata 和历史版本仍保留。`purge=true` 会清理对象存储，后续列表中也不再出现该模板。

## 7. 生成单份文档

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-renders` |
| HTTP Method | `POST` |
| 适用场景 | 根据一个模板生成一份文档。 |
| 推荐方式 | 生产生成 Docx 时传 `template.format: "docx"` 和 `template.templateId`。 |

### 请求体

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `template.format` | string | 是 | `doc` 或 `docx`。生产下载文件使用 `docx`。 |
| `template.title` | string | 否 | 文档标题或响应展示标题。 |
| `template.content` | string | `doc` 必填 | `doc` 文本预览模式使用的模板正文。 |
| `template.url` | string | `docx` 二选一 | Docx 模板下载链接。兼容旧方式，不推荐作为生产主流程。 |
| `template.templateId` | string | `docx` 二选一 | 模板库里的模板编号。推荐生产使用。 |
| `template.versionId` | string | 否 | 指定模板版本。不传时使用当前启用版本。 |
| `template.fileName` | string | 否 | 生成文件名兜底值。 |
| `variables` | object | 否 | 文本变量。值支持字符串、数字、布尔值和 `null`；`null` 会按空字符串处理。 |
| `imageVariables` | object | 否 | 图片变量，见「图片变量」。 |
| `missingStrategy` | string | 否 | 缺失文本变量处理策略。默认 `fail`；传 `blank` 时缺失文本变量按空字符串生成，图片变量仍必须提供。 |
| `output.fileName` | string | 否 | 下载文件名。服务端会自动补 `.docx`。 |
| `output.expiresInSeconds` | number | 否 | 下载链接有效期，最大 7 天。 |
| `output.includeFileBase64` | boolean | 否 | 是否在 `download.fileBase64` 返回文件内容。只建议侧边栏附件写回使用。 |
| `output.includePdfPreview` | boolean | 否 | 是否通过 Gotenberg 生成真实 PDF 预览并返回 `preview.pdf.fileBase64`。需要服务端配置 `GOTENBERG_URL`。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-renders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{
    "template": {
      "format": "docx",
      "templateId": "fbiftemp_20260512_001"
    },
    "variables": {
      "客户名称": "上海测试科技有限公司",
      "金额": "12800 元"
    },
    "output": {
      "fileName": "合同-上海测试科技有限公司.docx",
      "expiresInSeconds": 3600
    }
  }'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `format` | string | `doc` 或 `docx`。 |
| `document.title` | string | 文档标题。 |
| `document.previewText` | string | 服务端提取的预览文本。 |
| `variables.found` | string[] | 模板中识别到的文本变量。 |
| `variables.missing` | string[] | 模板需要但请求未提供的变量。成功时为空数组。 |
| `preview.pdf` | object | 请求 `output.includePdfPreview=true` 时返回，包含 `contentType`、`size`、`fileBase64`。 |
| `variables.provided` | string[] | 请求提供的变量名。 |
| `variables.unused` | string[] | 请求提供但模板未使用的变量。成功时为空数组。 |
| `download` | object | Docx 下载对象。`doc` 模式不会返回该字段；字段结构见「下载对象」。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "format": "docx",
  "document": {
    "title": "通用合同模板",
    "previewText": "客户：上海测试科技有限公司\n金额：12800 元"
  },
  "variables": {
    "found": ["客户名称", "金额"],
    "missing": [],
    "provided": ["客户名称", "金额"],
    "unused": []
  },
  "download": {
    "url": "https://signed-download-url",
    "path": "fbif-sidebar-docgen/prod/renders/2026/05/12/req-001.docx",
    "fileName": "合同-上海测试科技有限公司.docx",
    "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "size": 12345,
    "storage": "tos",
    "createdAt": "2026-05-12T00:00:00.000Z",
    "expiresAt": "2026-05-12T01:00:00.000Z"
  }
}
```

### 常见错误

| HTTP 状态码 | 错误信息 | 排查建议 |
|---|---|---|
| `400` | `Docx 模板必须提供 template.url 文档链接。` | 传 `template.templateId` 或 `template.url`。 |
| `400` | `模板不存在。` | 检查 `templateId`。 |
| `400` | `模板已删除，不能用于生成。` | 换用有效模板。 |
| `400` | `还有变量没有填写，请补齐后再生成。` | 查看 `missingVariables` 并补齐；若业务允许文本留空，可传 `missingStrategy: "blank"`。 |
| `400` | `PDF 预览服务未配置，请联系管理员。` | 请求了 `output.includePdfPreview=true`，但服务端未配置 `GOTENBERG_URL`。 |
| `400` | `有变量没有出现在模板中，请检查变量名。` | 查看 `unusedVariables` 并修正变量名。 |
| `400` | `模板中仍有未替换的变量占位符，请检查模板。` | 检查模板中是否有无法识别或拆分异常的占位符。 |

## 8. 同步批量生成

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-renders/batch` |
| HTTP Method | `POST` |
| 适用场景 | 一次生成不超过 100 条记录。 |
| 执行方式 | 每条记录独立生成，一条失败不影响其他记录。 |

### 请求体

| 名称 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `template` | object | 是 | 同「生成单份文档」的 `template`。 |
| `output` | object | 否 | 顶层默认输出配置。 |
| `records` | array | 是 | 1 到 100 条记录。 |
| `records[].recordId` | string | 是 | 业务记录 ID，1 到 128 字符。 |
| `records[].variables` | object | 否 | 单条记录的文本变量。 |
| `records[].imageVariables` | object | 否 | 单条记录的图片变量。 |
| `records[].output` | object | 否 | 覆盖顶层 `output`。 |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-renders/batch \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{
    "template": {
      "format": "docx",
      "templateId": "fbiftemp_20260512_001"
    },
    "records": [
      {
        "recordId": "rec_001",
        "variables": {
          "客户名称": "上海测试科技有限公司",
          "金额": "12800 元"
        }
      },
      {
        "recordId": "rec_002",
        "variables": {
          "客户名称": "北京测试科技有限公司"
        }
      }
    ]
  }'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `total` | number | 总记录数。 |
| `succeeded` | number | 成功数量。 |
| `failed` | number | 失败数量。 |
| `records[]` | array | 每条记录的独立结果。 |
| `records[].ok` | boolean | 单条记录是否成功。 |
| `records[].download` | object | 单条记录成功时返回，字段结构见「下载对象」。 |
| `records[].error` | string | 单条记录失败时返回。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "records": [
    {
      "recordId": "rec_001",
      "ok": true,
      "requestId": "req-rec-001",
      "download": {
        "url": "https://signed-download-url"
      }
    },
    {
      "recordId": "rec_002",
      "ok": false,
      "requestId": "req-rec-002",
      "error": "还有变量没有填写，请补齐后再生成。",
      "missingVariables": ["金额"]
    }
  ]
}
```

## 9. 提交异步批量任务

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-render-jobs` |
| HTTP Method | `POST` |
| 适用场景 | 100 条以上的大批量生成。单任务最多 500 条。 |
| 状态保存 | 配置 `DATABASE_URL` 时任务状态写入 PostgreSQL `render_jobs` 表；未配置数据库的本地开发/测试环境会降级为进程内存。运行中的任务会刷新执行租约，服务启动时只会把租约已过期的 `pending` / `running` 任务标记为 `failed`，避免多实例误杀仍在执行的任务。 |
| 查询权限 | 任务会绑定提交时的登录用户或 API Key；查询进度和结果时必须使用同一身份。身份不匹配时返回 `任务不存在。`，避免泄露任务是否存在。 |

### 请求体

请求体同「同步批量生成」，但 `records` 上限是 500。

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-render-jobs \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{
    "template": {
      "format": "docx",
      "templateId": "fbiftemp_20260512_001"
    },
    "records": [
      {
        "recordId": "rec_001",
        "variables": {
          "客户名称": "上海测试科技有限公司",
          "金额": "12800 元"
        }
      }
    ]
  }'
```

### 响应体

提交成功返回 HTTP `202`。

| 名称 | 类型 | 描述 |
|---|---|---|
| `job.jobId` | string | 异步任务 ID。 |
| `job.status` | string | 初始为 `pending`。 |
| `job.total` | number | 总记录数。 |
| `job.processed` | number | 已处理记录数。 |
| `job.succeeded` | number | 成功数量。 |
| `job.failed` | number | 失败数量。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "job": {
    "jobId": "job_1778540000000_abcd1234",
    "status": "pending",
    "total": 1,
    "processed": 0,
    "succeeded": 0,
    "failed": 0,
    "createdAt": "2026-05-12T00:00:00.000Z",
    "updatedAt": "2026-05-12T00:00:00.000Z"
  }
}
```

## 10. 查询异步任务进度

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-render-jobs/{jobId}` |
| HTTP Method | `GET` |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-render-jobs/job_1778540000000_abcd1234 \
  -H 'Authorization: Bearer <api-key>'
```

### 响应体

| 状态 | 含义 |
|---|---|
| `pending` | 已提交，尚未开始。 |
| `running` | 正在生成。 |
| `completed` | 全部成功。 |
| `partial_failed` | 部分成功、部分失败。 |
| `failed` | 任务级失败。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "job": {
    "jobId": "job_1778540000000_abcd1234",
    "status": "running",
    "total": 500,
    "processed": 120,
    "succeeded": 118,
    "failed": 2,
    "createdAt": "2026-05-12T00:00:00.000Z",
    "updatedAt": "2026-05-12T00:02:00.000Z"
  }
}
```

### 常见错误

| HTTP 状态码 | 错误信息 | 排查建议 |
|---|---|---|
| `404` | `任务不存在。` | 检查 `jobId`，或确认服务是否重启过。 |

## 11. 查询异步任务结果

### 请求

| 项目 | 说明 |
|---|---|
| HTTP URL | `/api/v1/document-render-jobs/{jobId}/results` |
| HTTP Method | `GET` |

### 请求示例

```bash
curl -s http://localhost:3000/api/v1/document-render-jobs/job_1778540000000_abcd1234/results \
  -H 'Authorization: Bearer <api-key>'
```

### 响应体

| 名称 | 类型 | 描述 |
|---|---|---|
| `job` | object | 当前任务摘要。 |
| `count` | number | 当前已保存的结果数量。 |
| `records[]` | array | 每条记录的生成结果。结构同同步批量生成的 `records[]`；成功记录里的 `download` 字段结构见「下载对象」。 |

### 响应示例

```json
{
  "ok": true,
  "requestId": "req-001",
  "job": {
    "jobId": "job_1778540000000_abcd1234",
    "status": "completed",
    "total": 1,
    "processed": 1,
    "succeeded": 1,
    "failed": 0,
    "createdAt": "2026-05-12T00:00:00.000Z",
    "updatedAt": "2026-05-12T00:00:10.000Z"
  },
  "count": 1,
  "records": [
    {
      "recordId": "rec_001",
      "ok": true,
      "requestId": "req-rec-001",
      "download": {
        "url": "https://signed-download-url"
      }
    }
  ]
}
```

## 模板变量

### 文本变量

模板里写：

```text
客户：{{客户名称}}
金额：{{金额}}
```

匹配规则：

| 规则 | 说明 |
|---|---|
| 完全匹配 | 请求里的键名必须和模板变量名一致。 |
| 自动去空格 | `{{ 客户名称 }}` 会按 `客户名称` 识别。 |
| 缺失变量 | 默认返回 `missingVariables` 且不生成半成品；传 `missingStrategy: "blank"` 时，缺失文本变量按空字符串生成，响应的 `variables.missing` 仍会列出这些变量。图片变量仍必须提供。 |
| 多余变量 | 请求里有、模板里没有时，接口返回 `unusedVariables`，提醒检查变量名。 |
| 残留占位符 | 输出仍有 `{{...}}` 时会拒绝生成。 |

Docx 里的正文、表格、页眉、页脚，以及 Word 把变量拆成多个文本节点的情况都会处理。

### 成品 Docx 转变量模板

如果一开始没有带 `{{变量}}` 的模板，可以直接在成品 Docx 里用 Word 或 WPS 批注标变量，再上传到模板接口。服务端会在入库前自动转换。

| 批注内容 | 批注范围 | 转换结果 |
|---|---|---|
| `变量：公司名称` | 选中成品里的公司名称文字 | `{{公司名称}}` |
| `图片变量：客户logo` | 选中成品里的 logo 图片 | `{{image:客户logo\|width=原图宽度\|height=原图高度\|align=原段落对齐}}` |

规则：

| 项目 | 说明 |
|---|---|
| 识别方式 | 只处理以 `变量：`、`变量:`、`图片变量：`、`图片变量:` 开头的批注。普通批注不会被处理。 |
| 文字变量样式 | 保留批注范围内第一个文字片段的基础样式，例如字体、字号、颜色、加粗、下划线等。 |
| 图片变量样式 | 读取原图片尺寸和所在段落对齐方式，自动写入图片变量参数。 |
| 可用位置 | 正文、表格单元格、页眉、页脚里的批注范围。 |

## 图片变量

模板里用 `{{image:变量名}}` 插入图片，也支持中文别名 `{{图片:变量名}}`。

图片变量必须单独占一个段落。可以放在正文、表格单元格、页眉或页脚中。不要写成 `Logo：{{image:logo}}`，这种混排写法会被拒绝，避免生成排版不确定的半成品。

### 模板写法

```text
{{image:logo}}
{{image:logo|width=30mm|align=center|alt=公司Logo}}
{{图片:产品图|宽=80mm|高=50mm|对齐=右|适配=contain}}
{{image:hero|oss=image/resize,w_1200|最大宽=160mm}}
```

### 模板参数

| 参数 | 别名 | 说明 |
|---|---|---|
| `width` | `w`、`宽` | 图片宽度，支持 `px`、`mm`、`cm`、`in`、`pt`。数字默认按 `px`。 |
| `height` | `h`、`高` | 图片高度，单位同上。只传宽或高时按原图比例缩放。 |
| `maxWidth` | `maxw`、`最大宽` | 最大宽度，默认 `160mm`。 |
| `maxHeight` | `maxh`、`最大高` | 最大高度。 |
| `align` | `对齐` | `left` / `center` / `right`，也支持 `左` / `居中` / `右`。默认 `center`。 |
| `fit` | `适配` | `contain` 保持比例，`stretch` 按宽高拉伸。默认 `contain`。 |
| `alt` | `说明` | 写入 Word 图片说明。 |
| `oss` | `ossProcess`、`x-oss-process`、`图片处理` | 阿里云 OSS 图片处理参数，例如 `image/resize,w_600`。 |

### 请求字段

| 字段 | 说明 |
|---|---|
| `imageVariables.<name>.url` | 图片下载链接。生产环境默认要求 HTTPS，且不能指向内网、本机或云元数据地址。`<name>` 推荐传不带前缀的变量名，如 `logo`；为兼容侧边栏和旧调用，也接受 `image:logo`、`图片:logo`。 |
| `imageVariables.<name>.urls` | 兼容侧边栏附件字段，传数组时使用第一张图。`<name>` 规则同上。 |
| `imageVariables.<name>.ossProcess` | 服务端会追加为 `x-oss-process=<值>`。如果使用 OSS 临时签名链接，建议签名时就包含图片处理参数。 |
| `imageVariables.<name>.width` / `height` | 覆盖模板占位符里的同名参数。 |
| `imageVariables.<name>.maxWidth` / `maxHeight` | 覆盖模板占位符里的同名参数。 |
| `imageVariables.<name>.align` / `fit` / `alt` | 覆盖模板占位符里的同名参数。 |

### 请求示例

```json
{
  "template": {
    "format": "docx",
    "templateId": "fbiftemp_20260512_001"
  },
  "variables": {
    "客户名称": "上海测试科技有限公司"
  },
  "imageVariables": {
    "logo": {
      "url": "https://example.com/logo.png",
      "ossProcess": "image/resize,w_600",
      "width": "30mm",
      "align": "center",
      "fit": "contain",
      "alt": "公司 Logo"
    }
  }
}
```

### 响应补充

使用图片变量时，成功响应会额外返回 `images`。

```json
{
  "images": {
    "found": ["logo"],
    "missing": [],
    "provided": ["logo"],
    "unused": [],
    "rendered": [
      {
        "name": "logo",
        "url": "https://example.com/logo.png?x-oss-process=image%2Fresize%2Cw_600",
        "widthPx": 113,
        "heightPx": 57,
        "align": "center",
        "fit": "contain",
        "contentType": "image/png",
        "originalWidthPx": 600,
        "originalHeightPx": 300,
        "ossProcess": "image/resize,w_600"
      }
    ]
  }
}
```

## 错误处理

所有业务错误都会返回 `ok: false` 和可展示给用户的 `error`。接入方不要依赖内部堆栈、对象存储路径或服务端日志。

| 场景 | 响应特征 | 处理方式 |
|---|---|---|
| 请求 JSON 不合法 | `error: "请求参数不合法。"` | 检查字段名、字段类型和必填字段。 |
| 模板里有变量未传 | 返回 `missingVariables` | 补齐变量后重试。 |
| 请求里有模板未使用的变量 | 返回 `unusedVariables` | 检查变量名是否写错，或移除多余变量。 |
| 模板不存在 | `error: "模板不存在。"` | 检查 `templateId` 是否正确。 |
| 模板已删除 | `error: "模板已删除，不能用于生成。"` | 上传新模板或换用其他模板。 |
| 模板链接不可访问 | `error` 提示模板链接无法访问 | 检查链接有效期、HTTPS、权限和重定向。 |
| 模板或图片指向内网 | `error` 提示不能指向内网或本机地址 | 改用公网 HTTPS 下载链接。 |
| 模板损坏或不是 Docx | `error` 提示模板格式不支持 | 重新导出标准 `.docx`。 |
| 生产环境缺对象存储 | `error` 提示配置错误 | 配置 OSS 或 TOS，生产环境不会降级到本地存储。 |
| 异步任务不存在 | `error: "任务不存在。"` | 检查 `jobId`，或确认服务是否重启过。 |

缺失变量示例：

```json
{
  "ok": false,
  "requestId": "req-001",
  "error": "还有变量没有填写，请补齐后再生成。",
  "missingVariables": ["金额"]
}
```

多余变量示例：

```json
{
  "ok": false,
  "requestId": "req-001",
  "error": "有变量没有出现在模板中，请检查变量名。",
  "unusedVariables": ["联系人"]
}
```

## 上线检查清单

- 已保存 `templateId`，生成时不再依赖原始模板下载链接。
- 变量名和模板里的 `{{变量名}}` 完全一致。
- 对合同、报价单等强版本场景，生成请求传了 `versionId`。
- 生产环境已配置模板 TOS 存储。
- 生产环境已配置生成文件 OSS 或 TOS 存储。
- 下载链接过期时间符合业务要求。
- 错误响应里的 `missingVariables` 和 `unusedVariables` 已在业务系统里可见。
- 异步任务状态在配置 `DATABASE_URL` 时写入 PostgreSQL；未完成任务会刷新执行租约，租约过期后才会被标记为失败，已完成且未过期任务仍可由提交时同一登录用户或 API Key 查询。

服务端配置、对象存储和故障排查见 `docs/docx-operator-runbook.md`。
