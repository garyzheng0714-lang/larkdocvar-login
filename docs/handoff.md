# 当前交接状态

更新时间：2026-07-17

本文件只记录当前实现、尚未由本地环境证明的事项和接手顺序。历史开发过程以 Git 提交为准。

## 当前实现

- 两条生成链路并存：飞书云文档模板与服务器 Docx 模板资产。两者共享侧边栏入口，但 API、权限与存储语义不同。
- Docx 模板支持上传、列表、详情、元数据更新、新增版本、软删除；生成支持单份、最多 100 条同步批量和最多 500 条异步任务。
- 生产模板资产必须存 TOS；生成文件必须存 OSS 或 TOS。PDF 预览按需调用 Gotenberg。
- PostgreSQL 保存用户、可信会话、映射配置、异步任务、渲染审计与 migration 版本。
- 登录顺序是：已有会话 → client-code 端内免登 → 绑定 Base `open_id` 的 OAuth handoff。QR 路由兼容保留，主界面不展示扫码入口。
- 旧 `/api/auth/feishu/:appKey/start`、`/login-status` 与未知登录子路径返回 410。

## 本地验证基线

2026-07-17 在当前工作树执行：

```bash
npm test
npm run build
npm run verify:secrets
git diff --check
```

结果应与 README 的当前状态一致。涉及对象存储、Docker、真实飞书或线上环境的检查不属于纯本地测试覆盖。

## 外部验收清单

以下事项没有本地证据时不得报告为“已上线”或“生产可用”：

1. 在真实飞书 Base 侧边栏验证 client-code 免登；免登失败时验证 handoff 能打开系统浏览器并由原侧边栏接回会话。
2. 验证 Base `open_id` 与 OAuth 应用 `open_id` 属于同一命名空间；不匹配时必须保持拒绝，不能删除身份绑定。
3. 单进程 handoff 只适合单实例。多实例部署前使用共享存储或粘性路由，并复验 5 分钟过期与单次消费。
4. 用真实 TOS bucket 验证模板并发写入的禁止覆盖语义，以及 OSS/TOS 生成文件下载。
5. 构建并运行生产 Docker Compose，验证 PostgreSQL 持久卷、Gotenberg 转换、非 root 运行和健康检查。
6. 核对线上飞书版 Docx API 文档与仓库 `docs/docx-api-integration.md` 一致。
7. 删除 handoff 身份不匹配日志、接口响应和前端诊断中的身份标识，并在真实拒绝路径确认终端用户与共享日志均不暴露该标识。
7. 核对部署提交、线上静态资源 hash 与 `/api/health`；没有这些证据时只能描述仓库状态。

## 接手顺序

1. 先读 `README.md`、`CLAUDE.md` 和 `CONTEXT.md`。
2. 改 Docx 契约前先改 `docs/docx-api-integration.md`，然后同步后端、侧边栏与线上飞书文档。
3. 部署或排障按 `docs/docx-operator-runbook.md`；业务合同自动化按 `docs/project-flow.md`。
4. 登录改动必须覆盖 client-code、handoff 成功/拒绝/过期/单次消费，并在真实 Base 验证。
