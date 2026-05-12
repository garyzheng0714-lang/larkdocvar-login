## Agent skills

### Issue tracker

GitHub Issues via `gh` CLI（仓库 `garyzheng0714-lang/larkdocvar-login`）。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 5 个标准 label，未做改名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根目录一份 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

### Docx API docs

- 项目语境与路由速查：`CONTEXT.md`
- 业务系统接入：`docs/docx-api-integration.md`
- 架构与存储边界：`docs/docx-api-architecture.md`
- 运维与故障排查：`docs/docx-operator-runbook.md`
- 阶段交接：`docs/handoff.md`
- 里程碑 1 验收审计：`docs/docx-api-milestone1-audit.md`

当前 Docx API 路由包括：

- `POST /api/v1/document-templates`
- `GET /api/v1/document-templates`
- `GET /api/v1/document-templates/:templateId`
- `GET /api/v1/document-templates/:templateId/versions`
- `POST /api/v1/document-templates/:templateId/versions`
- `DELETE /api/v1/document-templates/:templateId`
- `POST /api/v1/document-renders`
- `POST /api/v1/document-renders/batch`
- `POST /api/v1/document-render-jobs`
- `GET /api/v1/document-render-jobs/:jobId`
- `GET /api/v1/document-render-jobs/:jobId/results`

生产环境要点：

- 模板资产生产环境必须配置 TOS，不能使用本地模板存储。
- 最终生成 Docx 生产环境必须配置 OSS 或 TOS，不能使用本地临时下载链接。
- `DOCUMENT_RENDER_API_KEY` 开启后，业务系统用 API Key；已登录侧边栏用户可用会话。
- 真实密钥只能放 `.env.local`、部署密钥或运行环境变量，不写入仓库文档。

已知技术债：

- `src/SidebarApp.tsx` 是历史遗留大文件，已超过 900 行。继续改前端时优先拆出模板库、字段映射、生成进度和结果列表组件。
