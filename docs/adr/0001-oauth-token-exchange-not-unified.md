# ADR-0001：OAuth token 交换不抽统一 seam

- 状态：已接受
- 日期：2026-05-30

## 背景

架构 review 提出候选「把 OAuth code→会话下沉到一个 `finalizeOAuthSession` seam，并统一 button(v2) / qr(v1) 的 token 交换」。

复核 `server/src/oauthRoutes.ts` 后确认：

- `finalizeFeishuLogin`（约 347 行）**已经是**会话创建的集中 seam——token 交换之后的 user_info 拉取、tenant 白名单校验、`upsertUser`、`upsertSession`、cookie 下发、响应/重定向，全部在它内部，button 与 qr 两条回调共用。会话创建并不分散。
- 真正未统一的只有 token 交换本身：button 在 `handleButtonCallback` 内联 `axios.post` 飞书 authen v2 端点；qr 走 `exchangeCodeV1`（passport v1）。

## 决策

不抽 `finalizeOAuthSession`，不统一 token 交换。维持现状。

## 理由

1. v1 与 v2 是飞书两个**不同的真实 API**，请求参数与响应结构不同。抽成 `exchangeOAuthCode(kind)` 后内部仍需按 kind 分叉，并不消除本质差异，深度提升有限。
2. 该段直连真实飞书 OAuth 端点，在「只跑本地单测/构建」的约束下**无法端到端验证**。现有测试只能通过 mock `axios.post` 验证「走到了 token 交换」（见 `oauthRoutes.test.ts` 关于无 cookie state 的用例）。
3. 登录链路出过事（见 `docs/auth-login-incident-review-2026-05-14.md`）。在出过事、又不能真实验证的关键路径上做收益薄的重构，风险大于回报。

## 重新审视的条件

当出现第三种登录方式、或 token 交换逻辑本身需要扩展（如新增刷新策略）时重开此决策——届时统一 seam 才有明确收益，且应配合可真实验证 OAuth 登录的环境。
