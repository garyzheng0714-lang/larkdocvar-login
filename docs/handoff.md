# Handoff

更新时间：2026-05-12

## 2026-05-12 Docx API 可生产使用与批量生成

已完成：

- Docx 单份生成 API：支持正文、表格、页眉、页脚、脚注等 Word XML 部件里的 `{{变量}}`。
- Word 拆分文本节点变量替换：变量被拆成多个 `w:t` 也能替换。
- 生成文件存储：支持 OSS/TOS 带有效期下载链接，本地无对象存储时仅开发环境降级 local。
- 模板安全：拒绝内网、本机、云元数据、非 HTTPS、zip bomb、坏 Docx、伪装 Docx、超过 20MB 模板。
- 模板资产管理：`POST /api/v1/document-templates` 上传模板后返回 `templateId`；支持列表、查询、版本、软删除和 purge。
- 模板生成方式：后续请求可直接传 `template.templateId`，不需要重复传原始模板 URL。
- 批量生成：`POST /api/v1/document-renders/batch` 单批最多 100 条，逐条返回独立状态。
- 异步任务：`POST /api/v1/document-render-jobs` 单任务最多 500 条，支持查询进度和最终结果。
- API 鉴权：`DOCUMENT_RENDER_API_KEY` 保护业务系统 API；已登录侧边栏用户可用会话调用。
- 侧边栏 UI：新增“服务器 Docx 模板库”，支持保存模板下载链接、选择模板编号、删除模板，并接入现有多维表格批量生成流程。
- API 文档：飞书云文档维护干净版接入文档，仓库内新增接入、架构、运维和交接文档。

验证：

- `npm test`：143 个测试通过。
- `npm run build`：通过。
- `npm run verify:secrets`：通过。
- `git diff --check`：通过。
- 真实浏览器打开本地页面，Playwright 检查桌面和 390px 移动宽度下模板库保存、选择、字段映射流程。
- Docx 里程碑 1 完整验收报告见 `docs/docx-api-milestone1-audit.md`。

后续可选强化：

- 异步任务状态持久化到 PostgreSQL 或对象存储，以支持服务重启后继续查询历史任务。
- 拆分 `src/SidebarApp.tsx`，优先抽出服务器模板库、字段映射、生成进度和结果列表组件。
- 给侧边栏增加更友好的模板版本管理入口，目前版本新增主要面向 API。
