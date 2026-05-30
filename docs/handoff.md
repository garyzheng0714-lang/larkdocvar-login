# Handoff

更新时间：2026-05-15

## 2026-05-15 飞书登录 handoff 安全整改

已完成：

- 停用 `/api/auth/feishu/:appKey/start` 和 `/api/auth/feishu/:appKey/login-status` 的 JSON handoff，两个接口固定返回 410，避免攻击者用自己创建的 state 诱导他人授权后领取他人 session。
- 前端普通浏览器回退路径改为当前页跳转 `/auth/feishu/:appKey/login`，不再 `window.open`，飞书侧边栏内仍只走端内授权或显示可读错误。
- 服务端会话解析移除 query `session_token` 兜底，只保留 cookie、`X-Session-Token` 和 Bearer 候选。
- 登录检查增加请求序号和强制检查，避免旧的未登录响应清掉刚写入的端内登录 token。
- `tt.requestAccess` / `tt.requestAuthCode` 增加超时保护，避免按钮一直停在授权中。
- 登录配置缺失 API 返回统一用户文案，内部环境变量名只写服务器日志。
- 新增端内授权失败诊断日志：记录 `h5sdk`、`tt.requestAccess`、`tt.requestAuthCode` 是否存在和失败阶段，用于定位飞书宿主能力差异。
- 2026-05-15 线上复验诊断：真实 PC Lark 多维表格侧边栏 UA 为 `Lark/7.68.5` 且不含 `WebApp`，不是 H5 WebApp 授权容器。点击“使用 FBIF 飞书登录”后不拉起外部浏览器，直接留在插件内显示扫码登录；生产日志记录 `stage=pc_lark_not_webapp_container`。

## 2026-05-15 飞书客户端内登录修复

已完成：

- 确认更深一层根因：前端按钮把 `/api/auth/feishu/:appKey/start` 返回的授权地址直接 `window.open("_blank")`，所以用户必须离开插件面板完成授权。
- 明确不能只用 Base SDK 的 `getUserId/getTenantKey` 替代 OAuth，因为飞书云文档模板读取仍需要后端持有真实用户 OAuth token。
- 新增客户端内授权主路径：`src/feishuClientLogin.ts` 加载飞书 H5 SDK，调用 `tt.requestAccess` 获取 code；若宿主只暴露旧接口或 `requestAccess` 返回 103，则兼容 `tt.requestAuthCode`。随后提交到 `/api/auth/feishu/:appKey/client-code`。
- 新增 `/api/auth/feishu/:appKey/client-config` 和 `/api/auth/feishu/:appKey/client-code`，后端换取用户 OAuth token、创建 `users/auth_sessions` 并返回嵌入式会话 `session_token`。
- 外部 OAuth JSON handoff 后续已因安全问题停用；普通浏览器使用当前页 OAuth 跳转，飞书侧边栏内不再自动打开外部授权页。

验证：

- `npm run typecheck`：通过。
- `npm test`：189 个测试通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 真实飞书桌面侧边栏先退出登录，再点击“使用 FBIF 飞书登录”，停留在当前插件面板，不再拉起外部浏览器，并立即显示插件内扫码登录。生产诊断为 `pc_lark_not_webapp_container`；这是当前 PC Lark 多维表格侧边栏的预期路径，不再把它当作 OAuth 配置错误。
- 线上 `/api/auth/feishu/fbif/client-config` 返回当前 FBIF `app_id`。
- 线上 bundle 包含 `requestAccess`、`requestAuthCode`、`client-config`、`client-code`。
- Playwright 打开 `https://fbif-sidebar-docgen.fbif.com/?mock=1`，页面标题正确，控制台 0 error / 0 warning。

## 2026-05-15 飞书桌面侧边栏按钮登录 handoff 修复

已完成：

- 确认真实根因：飞书桌面侧边栏 iframe 和 Chrome 会话不共享；按钮 OAuth 被外部浏览器接管后，session cookie 和 `#session_token` 留在 Chrome，侧边栏仍未登录。
- 新增按钮登录 handoff：`/api/auth/feishu/:appKey/start` 返回授权地址和签名 state，侧边栏打开外部浏览器后轮询 `/api/auth/feishu/:appKey/login-status` 接回一次性 `session_token`。该方案后续因 state 可被钓鱼接管而停用，保留本段仅作事故复盘。
- 前端拿到 `session_token` 后写入嵌入式 localStorage，并通过 `X-Session-Token` 调用 `/api/auth/session`。
- 服务端会话解析支持候选 token：旧 cookie 无效时继续尝试 header、Bearer。query token 后续已移除。
- 生产 `POSTGRES_DATA_DIR` 迁到 `/opt/fbif-sidebar-docgen/data/postgres`，不再挂在 `/opt/fbif-sidebar-docgen/current/data/postgres`。
- 选择性发布 `login-handoff-20260515101329`，只覆盖登录相关源文件。

验证：

- `npm run typecheck`：通过。
- `npm test`：185 个测试通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 线上 `/api/health` 返回 `databaseReady:true`，`index.html` 为 `Cache-Control: no-cache`，当前前端资源为 `assets/index-CyUPls9n.js`。
- 真实飞书桌面侧边栏点击“使用 FBIF 飞书登录”后，按钮显示“等待授权完成...”，外部浏览器授权完成后侧边栏自动进入主界面。
- 生产库确认 `users=1`、`auth_sessions=2`；PostgreSQL 容器挂载为 `/opt/fbif-sidebar-docgen/data/postgres`。

## 2026-05-15 飞书登录生产缺表热修复

已完成：

- 定位线上真实根因为 PostgreSQL 缺少 `users` / `auth_sessions` 等登录表，OAuth 回调写会话失败后被泛化为登录失败。
- 生产库先备份，再执行 `server/migrations/001_initial_schema.sql`，并记录 `schema_migrations` 版本 `001:001_initial_schema`。
- 选择性热修复发布 `2b8a1ad-login-db-hotfix-20260515094600`，只覆盖登录数据库和健康检查相关后端文件。
- `/api/health` 增加 `databaseReady`，缺少登录必需表时生产健康检查失败。
- 新增 `server/src/storageReadiness.test.ts` 覆盖缺表识别。

验证：

- `npm run typecheck`：通过。
- `npm test`：184 个测试通过。
- `npm run build`：通过。
- 线上 `/api/health` 返回 `databaseReady:true`。
- 真实 Chrome 使用 FBIF 飞书账号授权后进入主界面；生产库确认 `users=1`、`auth_sessions=1`。

## 2026-05-14 飞书登录失败路径整改

已完成：

- OAuth 按钮登录和扫码登录失败路径改为 302 回前端登录页，并通过 `auth_error` 展示可读错误。
- 前端登录页会消费并清理 `auth_error`，不会把接口 JSON 留给用户。
- `/api/auth/session` 检查加入 10 秒超时，避免首屏长时间停在检查登录状态。
- 新增事故复盘和后续强制验收清单：`docs/auth-login-incident-review-2026-05-14.md`。

验证：

- `npm run typecheck`：通过。
- `npm test`：178 个测试通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- Playwright 验证失败回调会回到前端登录页，410px 侧边栏宽度无明显溢出，控制台无 warning/error。

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
- PostgreSQL 持久化：登录用户、会话、模板配置改由 PostgreSQL 保存，schema 通过 `server/migrations/` 自动迁移。
- 生产数据目录：部署脚本固定 `POSTGRES_DATA_DIR`，避免 PostgreSQL 数据跟随 release 目录丢失。
- 模板缩略图：模板创建和新增版本会返回 `thumbnail`，前端模板库直接消费 API 字段渲染预览。
- TOS 路径规范：支持 `DOCUMENT_TOS_ROOT_PREFIX`，模板和生成文件推荐分到 `templates/`、`renders/`。
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
- 侧边栏前端已拆到 `src/components/document-generator/`；继续优先拆小模板库、字段映射、生成进度和结果列表组件。
- 给侧边栏增加更友好的模板版本管理入口，目前版本新增主要面向 API。
