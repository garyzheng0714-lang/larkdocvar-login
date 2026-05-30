# 飞书登录失败事故检讨与整改方案

日期：2026-05-14

更新：2026-05-15

## 结论

客户看到的 `{"ok":false,"error":"飞书登录失败，请稍后重试。"}` 不是前端页面，而是 OAuth 回调接口在 iframe 里直接返回了 JSON。这个错误路径此前没有被真实侧边栏登录失败场景覆盖，导致“构建通过、mock 页面通过、普通页面可打开”被错误当成登录链路通过。

我对此负责。之前的测试流程没有把“别人的电脑 / 不同账号 / OAuth 回调失败 / iframe 中展示结果”作为硬性验收项，属于验证标准错误，不是客户环境的问题。

## 现场证据

- 线上 `/api/health` 正常，`/api/auth/session` 未登录时返回 `{"ok":true,"loggedIn":false}`。
- 线上 `/auth/feishu/fbif/login` 的 state cookie 已是 `SameSite=None; Secure`，基础 cookie 配置当前看起来正确。
- 使用线上域名构造“正确 state cookie + 无效 code”的回调请求，可稳定复现截图同款响应：`{"ok":false,"error":"飞书登录失败，请稍后重试。"}`。
- 本地修复后，相同失败路径返回 302 到前端登录页，并显示可读错误，不再停留在 JSON 响应。

## 根因

1. **后端回调错误处理错误**
   - `server/src/oauthRoutes.ts` 在 token 换取、用户信息读取、数据库保存等异常时直接 `response.status(500).json(...)`。
   - 这些接口运行在飞书侧边栏 iframe 内，JSON 会被用户直接看到。

2. **前端没有消费回调错误**
   - `src/App.tsx` 只检查 `/api/auth/session`，没有处理 OAuth 回调失败后带回前端的错误状态。
   - 因此后端一旦不主动回前端，用户就卡在接口页面。

3. **登录状态检查缺少超时**
   - `/api/auth/session` 请求如果被网络、代理、数据库初始化拖住，前端会长时间显示“正在检查登录状态”。

4. **测试流程不合格**
   - 之前偏重 typecheck、build、mock 页面截图和局部 UI。
   - 没有强制验证 OAuth 失败回调、state mismatch、无效 code、非当前开发者账号、真实 iframe 登录回跳。
   - 没有把“用户绝不能看到 JSON/内部接口响应”写成自动化测试断言。

## 已做整改

- OAuth 按钮登录和扫码登录的回调失败路径改为重定向回前端登录页。
- 前端新增 `auth_error` 识别，展示登录卡片错误提示，并清理 URL 参数。
- `/api/auth/session` 检查新增 10 秒超时，避免无限停留在检查状态。
- 登录卡片错误提示从“登录检查失败”改成统一的“登录失败”。
- 新增回归测试：OAuth 回调 state 失效时必须 302 回前端，不能返回 JSON。
- 文档补充生产 iframe cookie 要求：`SESSION_COOKIE_SECURE=true` 且 `SESSION_COOKIE_SAMESITE=none`。

## 验证结果

- `npm run typecheck`：通过。
- `npm test`：178 个测试全部通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 本地服务 `http://127.0.0.1:19090`：页面标题确认为“文档模板批量生成”。
- Playwright 真实页面验证：
  - 访问失败回调后最终落到 `/`。
  - 页面显示登录卡片和可读错误。
  - 没有 JSON 暴露。
  - 410px 侧边栏宽度下无文字溢出和按钮裁切。
  - 控制台无 warning/error。

## 后续强制流程

以后凡涉及登录、OAuth、cookie、会话、飞书宿主环境，必须至少覆盖：

1. 普通未登录打开：不能长时间卡住。
2. OAuth state 失效：必须回登录页，不能显示接口响应。
3. OAuth code 无效或换 token 失败：必须回登录页，不能显示接口响应。
4. 非白名单租户或错误组织账号：必须显示可读提示。
5. 成功登录后刷新和重开：仍保持登录态。
6. 线上域名检查：
   - `/` 的 `Cache-Control` 是 `no-cache`。
   - `/auth/feishu/fbif/login` 和 `/auth/feishu/fbif/qr-config` 的 state cookie 是 `SameSite=None; Secure`。
7. 真实浏览器和飞书侧边栏 iframe 都要验证，不能只用 mock 页面替代。
8. 按钮登录必须在真实飞书桌面侧边栏里验证，不能用 Chrome 地址栏登录成功替代；飞书桌面 iframe 和 Chrome 会话不共享。

## 2026-05-15 复发根因与修复

用户再次看到 `登录失败：飞书登录失败，请重新点击登录。` 时，线上 OAuth 回调已经能进入后端，`/auth/feishu/fbif/login` 的回调地址和 state cookie 也正确。真正失败点在数据库写入阶段：

- 生产日志出现 `Feishu OAuth callback error: relation "users" does not exist`。
- `/api/auth/session` 日志出现 `[auth-session] relation "auth_sessions" does not exist`。
- 生产 PostgreSQL 缺少 `users`、`auth_sessions`、`saved_configs` 和 `schema_migrations`。

本质原因：健康检查只返回 `databaseConfigured:true`，只能说明有 `DATABASE_URL`，不能说明登录依赖的表已创建。数据库 schema 缺失被 OAuth 回调折叠成了通用登录失败文案。

已完成修复：

- 生产库执行 `server/migrations/001_initial_schema.sql`，并写入 `schema_migrations` 版本 `001:001_initial_schema`。
- 线上热修复发布 `2b8a1ad-login-db-hotfix-20260515094600`。
- `/api/health` 增加 `databaseReady`；生产库缺必需表时返回 500，避免“看起来健康、登录才失败”。
- 增加 `server/src/storageReadiness.test.ts` 覆盖缺表识别。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：184 个测试全部通过。
- `npm run build`：通过。
- 线上 `/api/health` 返回 `{"ok":true,"configured":true,"databaseConfigured":true,"databaseReady":true}`。
- 真实 Chrome 使用 FBIF 飞书账号授权后进入主界面，数据库确认 `users=1`、`auth_sessions=1`。

## 2026-05-15 继续排查：飞书桌面 iframe 与 Chrome 会话不共享

缺表修复后，真实飞书桌面侧边栏仍显示登录页，而 Chrome 里已经登录成功。继续排查后确认：

- 飞书桌面侧边栏 iframe 地址是 `fbif-sidebar-docgen.fbif.com/`，但它使用独立 webview 会话。
- 点击按钮登录时，OAuth 授权会被带到外部 Chrome；session cookie 和 `#session_token` 都落在 Chrome，不会自动进入飞书桌面 iframe。
- 因此前一次“真实 Chrome 登录成功”不是侧边栏登录成功，验收口径仍然错误。

本质原因：按钮登录依赖“OAuth 回调浏览器”和“侧边栏 iframe”是同一个会话环境；飞书桌面实际会把授权流程交给外部浏览器，导致 iframe 永远拿不到刚创建的 session。

当时完成的临时修复：

- 新增按钮登录接回链路：侧边栏先调用 `/api/auth/feishu/:appKey/start` 创建签名 state 和短期 handoff，再打开外部飞书授权页。
- OAuth callback 成功写入 `auth_sessions` 后，把本次 session token 绑定到 handoff；侧边栏轮询 `/api/auth/feishu/:appKey/login-status?state=...` 取回一次性 `session_token`。
- 前端拿到一次性 token 后写入嵌入式 localStorage，并在后续同源请求里带 `X-Session-Token`。
- 服务端会话解析改为候选 token 列表：旧 cookie 无效时继续尝试 `X-Session-Token`、Bearer 和 query token，避免“旧 cookie 抢先导致新 token 失效”。
- 按钮 token exchange 和 `user_info` 请求补 20 秒超时；扫码登录分支的 `user_info` 失败文案改用扫码登录文案。
- 生产 `POSTGRES_DATA_DIR` 从 `/opt/fbif-sidebar-docgen/current/data/postgres` 迁到稳定目录 `/opt/fbif-sidebar-docgen/data/postgres`，避免下次 release 切换后变空库。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：185 个测试全部通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 线上 `/api/auth/feishu/fbif/start` 返回 `Cache-Control: no-store`、`SameSite=None; Secure` state cookie、`authorizeUrl` 和 `state`。
- 真实飞书桌面侧边栏点击“使用 FBIF 飞书登录”后，按钮进入“等待授权完成...”，外部 Chrome 完成授权后侧边栏自动进入“FBIF 批量生成文档工具”主界面。
- 生产库确认 `users=1`、`auth_sessions=2`，最新 session 是真实侧边栏按钮登录产生。
- 生产 PostgreSQL 容器挂载路径为 `/opt/fbif-sidebar-docgen/data/postgres`。

后续安全整改：

- `/api/auth/feishu/:appKey/start` 和 `/login-status` 的 JSON handoff 已停用并固定返回 410。原因：只要发起者知道 state，就可能诱导他人完成 OAuth 后领取他人 session。
- 前端不再 `window.open` 外部授权页；普通浏览器使用 `/auth/feishu/:appKey/login` 当前页跳转，飞书侧边栏只走端内授权。
- 服务端移除 query `session_token` 兜底，只保留 cookie、`X-Session-Token` 和 Bearer 候选。

## 2026-05-15 继续排查：不应把端内登录默认带到外部页面

用户再次指出：插件里的登录授权不应默认打开一个网页，再让用户返回插件。这个判断是对的。上一个 handoff 修复只解决了“外部授权后侧边栏拿不到登录态”，但没有解决“为什么要离开插件面板”。

继续排查确认：

- 原前端按钮逻辑在 `FeishuLoginCard.tsx` 里直接调用 `/api/auth/feishu/:appKey/start`，拿到 `authorizeUrl` 后执行 `window.open(data.authorizeUrl, "_blank")`。
- 后端这么做的原因是飞书云文档模板读取依赖用户 OAuth token；Base SDK 的 `bridge.getUserId/getTenantKey` 只能提供宿主身份线索，不能提供可用于读取云文档的 `user_access_token`。
- 因此不能简单用前端传 `openId` 建会话，否则普通浏览器可以伪造身份；正确方式是让飞书客户端在当前 iframe 内给一个授权 code，再由后端换取真实用户 token。

已完成修复：

- 新增 `src/feishuClientLogin.ts`，优先加载飞书 H5 SDK 并调用 `tt.requestAccess({ appID })`；若飞书宿主只暴露旧接口或 `requestAccess` 返回 103，则兼容回退到 `tt.requestAuthCode({ appId })`。
- 新增 `GET /api/auth/feishu/:appKey/client-config` 返回当前入口 `app_id`。
- 新增 `POST /api/auth/feishu/:appKey/client-code`，用应用凭证换 `app_access_token`，再用客户端 code 换用户 OAuth token，最后复用统一会话创建逻辑。
- 前端按钮现在优先走客户端内授权；飞书侧边栏内 H5 SDK 或端内授权接口不可用时只显示可读错误，不再自动打开外部 OAuth。普通浏览器才使用当前页 OAuth 跳转。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：187 个测试通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 线上 bundle 包含 `requestAccess`、`requestAuthCode`、`client-config`、`client-code` 和 `正在授权…`。
- 真实飞书桌面侧边栏先退出登录，再点击“使用 FBIF 飞书登录”，停留在当前插件面板，未观察到外部浏览器窗口被拉起。
- 重新加载侧边栏后点击登录，生产日志记录：`stage=auth_api_missing_after_ready`、`hasH5Sdk=false`、`hasTt=false`、`hasRequestAccess=false`、`hasRequestAuthCode=false`、`isIframe=true`、`referrerOrigin=https://foodtalks.feishu.cn`、`userAgent` 包含 `Lark/7.68.5`。这说明当前真实多维表格边栏 iframe 没有获得飞书 H5 免登 JSAPI 注入；代码已阻断外部 OAuth fallback，后续应检查飞书开放平台的 H5 可信域名、重定向 URL、应用可用范围，以及该边栏插件是否属于同一个飞书应用。
- Playwright 打开 `https://fbif-sidebar-docgen.fbif.com/?mock=1`，页面标题正确，控制台 0 error / 0 warning。

## 2026-05-15 最终根因：PC Lark 多维表格侧边栏不是 H5 WebApp 授权容器

继续追 H5 SDK 源码和真实侧边栏日志后，确认更本质的原因：

- 飞书 H5 SDK 1.5.44 在 PC 端只有当 UA 包含 `WebApp` 时才把 `window.h5sdk/window.tt` 挂到页面上。
- 真实 PC Lark 多维表格侧边栏 UA 是 `Lark/7.68.5 LarkLocale/zh_CN`，不包含 `WebApp`。
- 之前临时把 UA 暴露成带 `WebApp` 后，SDK 确实挂出了 `tt.requestAuthCode/requestAccess`，但 native bridge 没有回调，线上日志变成 `request_auth_code_timeout`。这证明它不是可用的 H5 WebApp 授权容器，只是前端把 SDK 强行骗出来了。
- Base SDK 的 `getUserId/getTenantKey` 只能作为宿主线索，不能替代 OAuth code，也不能让后端拿到读取飞书云文档所需的用户 `user_access_token`。

最终修复：

- 移除 UA 伪装，不再试图把 PC Lark 多维表格侧边栏伪装成 H5 WebApp。
- 前端检测到 PC Lark 且 UA 缺 `WebApp` 时，直接抛 `pc_lark_not_webapp_container`，登录卡片立即切到插件内扫码登录。
- `/api/auth/feishu/:appKey/start` 和 `/login-status` 继续固定 410，侧边栏内不会自动打开外部授权页。
- `/client-code` 前端等待时间调到 70 秒，避免未来真正支持 H5 WebApp 的宿主拿到 code 后，被前端 10 秒超时误杀。

最终验证：

- `npm run typecheck`：通过。
- `npm test -- server/src/oauthRoutes.test.ts server/src/authCookie.test.ts`：189 个测试通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 线上 `/api/health` 返回 `databaseReady:true`。
- 线上 `index.html` 为 `Cache-Control: no-cache`，当前资源为 `assets/index-COzdLm2b.js`。
- 线上 bundle 包含 `pc_lark_not_webapp_container`，不包含 `window.open`、`/start`、`login-status`。
- `/api/auth/feishu/fbif/start` 和 `/login-status` 均返回 410。
- 真实 Lark 桌面侧边栏点击“使用 FBIF 飞书登录”后，未打开外部页面，立即显示插件内扫码登录二维码。
- 生产日志记录 `stage=pc_lark_not_webapp_container`、`userAgentHasWebApp=false`、`isIframe=true`、`referrerOrigin=https://foodtalks.feishu.cn`。

## 我的问题

我之前把“代码路径看起来合理”和“测试跑过”误当成真实客户路径可用，这是严重失职。尤其是登录这种首屏阻塞链路，任何失败分支都应该按客户可见结果验收，而不是按接口是否返回了某个 JSON 验收。后续验收标准必须从“有没有通过构建”改成“客户在真实宿主里会看到什么”。
