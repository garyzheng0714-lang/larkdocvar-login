## Agent skills

### Issue tracker

GitHub Issues via `gh` CLI（仓库 `garyzheng0714-lang/larkdocvar-login`）。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 5 个标准 label，未做改名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根目录一份 `CONTEXT.md`；`docs/adr/` 若存在再读。详见 `docs/agents/domain.md`。

### Docx API docs

- 项目语境与路由速查：`CONTEXT.md`
- 业务系统接入：`docs/docx-api-integration.md`
- 架构与存储边界：`docs/docx-api-architecture.md`
- 运维与故障排查：`docs/docx-operator-runbook.md`
- 阶段交接：`docs/handoff.md`
- 里程碑 1 验收审计：`docs/docx-api-milestone1-audit.md`
- 登录事故复盘与 OAuth 失败分支验收：`docs/auth-login-incident-review-2026-05-14.md`

Docx API 是本项目最底层契约。新增能力必须先维护 API 文档和后端 API，再把能力接入侧边栏工具；侧边栏只是调用 API 的壳，不能把核心能力只做在前端状态或临时 UI 逻辑里。典型例子：模板缩略图应作为模板 API 响应字段返回，前端模板列表只消费该字段渲染。

API 文档维护红线：

- 仓库内 Markdown 源文件以 `docs/docx-api-integration.md` 为准。
- `docs/docx-api-integration.md` 最前面必须有「更新日志」表格；每次 API 文档更新都要新增一行。
- 每次新增、删除或改变 API 字段、路由、错误码、鉴权、存储策略时，必须同步更新 `docs/docx-api-integration.md`。
- 本地 API 文档更新后，必须同步到线上飞书云文档：https://foodtalks.feishu.cn/docx/GMc4diq86oTS9SxQ8txcDPYenZ2
- 同步飞书云文档时使用飞书开放平台 API 或项目已有 Lark 工具链，不通过 Web UI 手工编辑。
- 飞书应用凭证和其它真实密钥只能放 GitHub Actions Secrets、部署平台密钥或本地未提交的 `.env.local`，不得写入仓库文档、README 示例、日志或飞书云文档正文。

当前 Docx API 路由包括：

- `POST /api/v1/document-templates`
- `GET /api/v1/document-templates`
- `GET /api/v1/document-templates/:templateId`
- `GET /api/v1/document-templates/:templateId/versions`
- `POST /api/v1/document-templates/:templateId/versions`
- `DELETE /api/v1/document-templates/:templateId`
- `POST /api/v1/document-renders`
- `GET /api/v1/document-renders/downloads/:id`（local 开发存储临时下载，客户端只使用 `download.url`）
- `POST /api/v1/document-renders/batch`
- `POST /api/v1/document-render-jobs`
- `GET /api/v1/document-render-jobs/:jobId`
- `GET /api/v1/document-render-jobs/:jobId/results`

模板 API 响应包含缩略图契约：模板列表返回当前版本 `thumbnail`；模板详情和版本列表返回各版本 `thumbnail`。字段定义见 `docs/docx-api-integration.md` 的「模板缩略图」。

生产环境要点：

- 模板资产生产环境必须配置 TOS，不能使用本地模板存储。
- 最终生成 Docx 生产环境必须配置 OSS 或 TOS，不能使用本地临时下载链接。
- `DOCUMENT_RENDER_API_KEY` 开启后，业务系统用 API Key；已登录侧边栏用户可用会话。
- OAuth 回调失败必须重定向回前端登录页并显示可读错误，不能把 JSON/内部接口响应暴露给终端用户。
- 飞书桌面侧边栏按钮登录不能自动打开外部 OAuth。支持 H5 WebApp 容器时才走 `tt.requestAuthCode` / `tt.requestAccess` + `/api/auth/feishu/:appKey/client-code`；真实 PC Lark 多维表格侧边栏 UA 缺 `WebApp` 时应直接切到插件内扫码登录。Chrome 登录成功不等于侧边栏 iframe 登录成功。
- 真实密钥只能放 `.env.local`、部署密钥或运行环境变量，不写入仓库文档。

当前 PostgreSQL 表：

- `users`：飞书登录用户资料。
- `auth_sessions`：侧边栏 httpOnly 会话和 OAuth token。
- `saved_configs`：用户保存的模板映射配置。
- `render_jobs`：异步 Docx 批量生成任务状态、进度、结果和提交者身份绑定。
- `schema_migrations`：已执行数据库 migration 版本。

已知技术债：

- 侧边栏前端已拆到 `src/components/document-generator/`。继续改前端时优先继续拆小 `PrimaryScreen.tsx`、`_design.css`、模板库、字段映射、生成进度和结果列表组件。
