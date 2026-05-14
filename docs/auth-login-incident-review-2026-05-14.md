# 飞书登录失败事故检讨与整改方案

日期：2026-05-14

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

## 我的问题

我之前把“代码路径看起来合理”和“测试跑过”误当成真实客户路径可用，这是严重失职。尤其是登录这种首屏阻塞链路，任何失败分支都应该按客户可见结果验收，而不是按接口是否返回了某个 JSON 验收。后续验收标准必须从“有没有通过构建”改成“客户在真实宿主里会看到什么”。
