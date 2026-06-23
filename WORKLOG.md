# 云文档变量批量生成 — 优化工程 WORKLOG

最后更新：2026-06-23

## 目标
在不推倒重写的前提下，把"飞书侧边栏 Docx 变量批量生成"打磨成可放心使用的版本。
2026-06-23 探针实测确认：**核心生成引擎健康**（10 个变量零错误替换，金额/公司名/展位号全对）。问题是分层的、可外科手术解决，**无需重构**。

## 范围与决策

### 要做（用户 2026-06-23 批准「其他可以修复」）
1. **[高] 生产运维 + 可追溯**
   - 渲染审计落库：单次 `document-renders` 当前不落库；日志容器重建即丢，出问题无法回溯。
   - 启动时关键配置自检：`DOCUMENT_RENDER_API_KEY` 之前未配置导致生产裸奔 / 工作流全 401。
2. **[中] 引擎 run 归一化**：模板文字被切碎（"基本配置"→"基"+"本配置"），变量正好跨 run 时有替换失败隐患。引擎已用 `easy-template-x`（见 documentRenderEasyTemplate.test.ts）。
3. **[中] 前端拆分 + UI 细节**：`_components.css` 1863 行（超 900 上限，首要拆分目标）；`PrimaryScreen.tsx` 已拆到 342 行（基本达标）。风格不大改，只拆分 + 细节打磨。
4. **[低] 文档真实响应示例 + 下载链接有效期可调**：接入方对接体验（用户已踩响应体配置坑）。

### 不做（已砍）
- ❌ **业务数据防错**（金额=0 等关键字段校验）
  - 决策人：用户，2026-06-23
  - 理由：**无通用性**。校验字段因模板而异（金额只对合同有意义），通用机制会退化成"给每个模板写特例"，不划算。

## 当前状态
- 401 鉴权：✅ 已修（配置 `DOCUMENT_RENDER_API_KEY` + 重启，公网真机 200）
- API 文档：✅ 本地 + 飞书云文档已同步（认证段 + 401 排查表 + 更新日志行）
- 生成质量评估：✅ 完成，结论=引擎健康，"000 金额"为输入数据问题
- 优化工程：🔄 **审查中**（本文档建立，逐项核实现状）

## 审查发现（2026-06-23 已核实，落到文件/函数级）
- **引擎 run 归一化：✅ 已实装，移出范围。** `documentRenderApi.ts:540-587` 用 easy-template-x（`TemplateHandler`，`{{ }}` 分隔符）；`:542` 注释"run 归一化 + 正确处理跨 run/多行/嵌套表格"；`:535` 默认 easy-template-x，可 env 回退 legacy。今天探针 10 变量零错误替换即验证有效。**可选**：审 `:592` easy-template-x 未覆盖部件的残留占位符兜底是否完善。
- **配置自检：🔴 空白。** `env.ts` 仅 18 行，只 load dotenv，无任何必填校验 → 关键配置缺失静默裸奔（API key 裸奔事故根因）。
- **渲染落库审计：🟡 缺失。** 仅异步批量写 `render_jobs`（storage.ts:412）；单次 `document-renders` 与同步 batch 不落库，运行时无审计，日志容器重建即丢。
- **前端：🟡** 最大文件 `_components.css`（1863 行，超 900 上限），首要拆分目标；`PrimaryScreen.tsx` 342 行已基本达标。

## 待办
- [x] ~~引擎 run 归一化~~ — 已实装（easy-template-x），探针验证有效，移出范围
- [x] [高] 配置自检 ✅ **已完成**：`server/src/configSelfCheck.ts` + 接入 `index.ts:bootstrap`；5 项生产必备配置启动自检，缺失醒目告警，默认不阻断、`DOCUMENT_RENDER_STRICT_CONFIG=true` 拒启动；单测 7/7 通过，tsc 0 错误。
- [x] [中] 渲染落库审计 ✅ **已完成**：migration 004 + `documentRenderAudit.ts` + `storage.insertRenderAudit` + 接入单次渲染；fire-and-forget；codex 审查通过；13 测试全过。
- [x] [中] 前端 `_components.css` 拆分 ✅ **已完成**：1863 行拆 4 文件（全 <900），diff 逐字节验证零变化，vite build 通过；真机验证并入部署后。
- [x] [低] 响应示例文档 ✅ **本地完成**：集成提示 + 有效期说明 + 更新日志；飞书同步在 task4。
- [x] [task4] 文档同步飞书 ✅：集成提示段插入飞书 + runbook STRICT_CONFIG + CLAUDE.md 表清单补 render_jobs/render_audit
- [x] [task5] commit & push ✅：2 次提交（功能 + 测试回归修复 fb30cf4）已 push main
- [x] [task6] 部署生产 + 真机验证 ✅：GitHub Actions 部署成功；`[config-self-check] ✅ 配置自检通过（production）`；render_audit 端到端落库（requestId/模板/status/变量计数/storage/caller 全对）；前端生产 CSS 字节级相同 + 登录页真机渲染正常

## 最终交付（2026-06-23 全部完成）
6 项全绿：配置自检 + 渲染审计 + 前端 CSS 拆分 + 文档（已同步飞书）+ commit/push + 部署/真机验证。CI 一次失败（2 测试回归）已修复二次部署通过。

## 时间线
- 2026-06-23：修 401 → 同步文档 → 评估生成质量 → 立项优化工程（砍数据防错）→ 开始真实审查
- 2026-06-23（下午）：登录可信化重构立项（见下）

---

# 登录可信化重构（2026-06-23 立项）

## 现象（用户报告）
飞书桌面侧边栏「新建模板」里出现「请先完成可信登录」+「登录态没有接上」，点「重新尝试飞书免登/扫码备用登录」**没反应**。用户判断"登录态整个不可信，值得整个登录重构"。

## 诊断（已逐文件核实，2026-06-23）
- **"点了没反应"的机制**：`cloudDoc/feishuTrustedLogin.ts:253` 的 `tryFeishuClientTrustedLogin()` **把所有失败吞掉、静默 return false**。点"重新尝试飞书免登"→ 重跑同一条静默失败路径 → 又弹回一模一样的卡片。违反 CLAUDE.md 规则十二「显式失败」。
- **最大嫌疑根因**：`feishuTrustedLogin.ts:256` 在免登前有 `if (isFeishuDesktopClientWithoutWebApp()) return false`（判定 `:52` = 飞书客户端 && 非移动端 && UA 不含 "WebApp"）。**飞书 Mac 桌面侧边栏 webview UA 基本不含 "WebApp" → 桌面端根本不尝试免登**。这与 CLAUDE.md「桌面侧边栏必须优先走 client-code 免登」**直接冲突**。
- **架构其实健全**：后端 `authSessionRoutes.ts` + `auth.ts` 已实现 skill 2026-05 事故复盘要求的整套——签名 state(HMAC) + cookie 兜底、HttpOnly cookie + `#session_token` hash 兜底、`X-Session-Token` header、cookie→header→Bearer 解析顺序、30 天滑动、双租户。前端 `authSessionToken.ts` 已做 localStorage token 兜底 + monkey-patch fetch 自动带 header。**后端就是 feishu-login-guide skill 标准的落地**，skill Step 1 明确"已有 session 体系不要平行新建"。

## 决策
- **用户拍板：整个登录重构**（我的外科手术建议被否，决策已记录，不再回头争）。
- **登录模型（用户选，skill Step 2 强制问）：端内免登为主 + 扫码兜底**，去掉浏览器 OAuth 双按钮门面（插件只在飞书 Base 侧边栏里跑，离了飞书拿不到 Base 上下文，本来也用不了）。
- **承重墙保留**：后端 cookie/header 双通道会话管道 = iframe 能登录的前提，不砸。"重构"= 把**前端登录编排**推倒重铺干净。

## 项目事实（已核对）
- 生产域名 `https://fbif-sidebar-docgen.fbif.com`（GitHub Actions 注入），无需问。
- **FBIF 单企业**：`fude` 后端支持但前端无入口（grep 全空），登录写死 `/api/auth/feishu/fbif/...`。不引入双按钮。
- env 命名已是 skill v3（`FEISHU_FBIF_*`）。

## 范围
### 要做（前端登录编排重铺）
1. **[核心] `feishuTrustedLogin.ts` 失败可见化**：`tryFeishuClientTrustedLogin()` 返回结构化结果 `{ ok, stage, reason }` 而非静默 boolean；把诊断 stage 映射成人话原因。
2. **[核心] 删桌面免登闸门**：移除 `isFeishuDesktopClientWithoutWebApp()` 的预先短路，桌面端真的尝试 client-code 免登（靠已有 5s/10s 超时兜底，失败响亮报因 + 转扫码）。
3. **[核心] Mode A 形态**：`App.tsx` `AuthGate` 去掉 OAuth 双按钮，改"免登（带 spinner）→ 失败显示原因 + 扫码 + 重新尝试免登"。
4. **[核心] NewTemplateScreen 卡片统一**：消费同一结构化结果，"重新尝试飞书免登"真的重跑免登（loading 态）而非静默再失败；失败显示具体原因 + 扫码。

### 不做
- ❌ 不动后端 auth 路由 / 会话管道（已是 skill 标准，砸了纯增风险）。
- ❌ 不引入 fude 前端双按钮（本项目 FBIF 单企业）。

## 验收标准
- 桌面侧边栏免登失败时，UI 显示**具体原因**（不再是"登录态没有接上"死卡片），且能一键转扫码。
- "重新尝试飞书免登"点击有可见反馈（spinner / 新结果），不再"点了没反应"。
- 免登成功 → 直接进插件；扫码成功 → 自动继续保存。
- build + tsc 通过；真机侧边栏验证（需用户配合，诚实标注）。

## 状态
- ✅ 代码改完（4 处）：
  - `feishuTrustedLogin.ts`：`tryFeishuClientTrustedLogin()` 返回 `{ok, stage, reason}` + stage→人话映射；删除 `isFeishuDesktopClientWithoutWebApp()` 桌面预先短路。
  - `App.tsx` `AuthGate`：去掉 OAuth 双按钮 + `startOAuthLogin`；免登失败显示具体原因 + [重新尝试飞书免登] + [扫码登录]。
  - `NewTemplateScreen.tsx`：`ensureTrustedSessionForTemplateSave` 先显 loading 再消费结构化结果、失败显具体原因；去掉叠加的通用 setError；"重新尝试飞书免登"改为真的重跑（loading 反馈）。
- ✅ 已验证：`tsc --noEmit` 干净；`vite build` 通过；`authSessionRoutes.test.ts` 10/10 通过；静态一致性（OAuth 双按钮门面无残留、两个调用点都已适配）。
- ✅ 已部署并验证 bundle（2026-06-23）：commit `895078a`(登录) + `51edea8`(测试断言) + `c8779ba`(初始文案)，GitHub Actions 部署成功。线上 `fbif-sidebar-docgen.fbif.com` bundle `index-DjjXPg2_.js` 实测：新文案"正在尝试飞书免登/改用扫码登录/飞书免登未能完成"在线，旧 OAuth 双按钮门面("使用 FBIF 飞书登录"等)+ 旧 loading 文案 0 残留。全量测试 301/301。
  - 踩坑：首发 push 部署在 Test 步失败——`sidebarResponsiveLayout.test.ts` 用源码字符串断言登录文案，3 条断言因重构过时。已改为断言重构后稳定锚点（规则九：测意图不测字面）。
- ⏳ **唯一未验证（诚实标注，需用户配合）**：真实飞书桌面侧边栏里的 client-code 免登成功路径 + 扫码兜底——`tt.requestAccess` 只在飞书端内存在，本地普通浏览器跑不出。需用户在飞书桌面侧边栏「新建模板」实测一次：免登成功直接进 / 失败显具体原因(stage)+可转扫码 / "重新尝试"有反馈。删桌面 UA 闸门是基于"桌面 UA 不含 WebApp"的推断；即使推断错，失败也会响亮报因（不再死卡片）。

## 阶段2：Base 侧边栏免登路线（2026-06-23 续，**进行中**）

### 真机诊断铁证（用户实测，2026-06-23）
免登失败卡片显示：`h5sdk_missing | h5sdk=N · tt=N · reqAccess=N · reqAuthCode=N · iframe=Y · lark=Y · webapp=N`
→ **结论：这是飞书桌面客户端(lark=Y)的 Base 扩展 iframe 侧边栏，容器内不注入任何授权 JSAPI（h5sdk/tt 全无）。client-code 免登结构性不可行**——不是 bug，是 Base 扩展容器不给授权 API。（顺带印证了原 `isFeishuDesktopClientWithoutWebApp` 桌面闸门的判断没错，错只错在静默→死卡片；现已改成响亮报因。）
- 诊断功能已上线：commit `1872587`，bundle `index-CRb94aX8.js`，`captureClientEnv()` 在 `feishuTrustedLogin.ts` + AuthGate/NewTemplateScreen 卡片显示 detail。

### 用户决策（2026-06-23）
- **永远不要扫码**：扫码彻底出局，不做主入口、不做兜底。
- **选 A**：走 **Base SDK 原生「可验证」免登**（真零点击，用户在飞书里本来就登着）。

### A 路线待研究的关键问题（compact 后第一件事）
1. 飞书 Base 扩展 SDK `@lark-base-open/js-sdk` 是否提供**可验证**的免登凭证？现有 `bitable.bridge.getUserId()`(openId)/`getBaseUserId()`/`getTenantKey()` 都是**不可验证**身份提示（CLAUDE.md 红线：`X-Bitable-*` 不能替代登录）。
2. 是否有类似"`bitable.bridge` 拿 authorization code / signed token"的 API，后端能拿去飞书验证/换 `user_access_token`？
3. 查证途径：`lark-base` skill、`lark-openapi-explorer` skill、feishu-login-guide `references/official-docs/`、飞书开放平台「多维表格扩展脚本/插件 鉴权」文档、WebSearch。

### 候选实现
- **A（首选）**：前端 `bitable.bridge.<可验证API>()` → POST 新后端路由（如 `/api/auth/feishu/fbif/base-code`）→ 后端向飞书验证 → 建 session（复用 `finalizeTrustedLogin`/`upsertSession` + cookie/header 双通道）。**前提是问题1/2 有肯定答案。**
- **B（A 不成时兜底，非扫码）**：新标签页 OAuth handoff（点按钮授权，不是扫码）+ 同源 localStorage 把 `session_token` 带回 iframe。注意：项目曾上线又下线（runbook 标"session 接管风险"），重做须签名 state + 短时效 + 同源校验做对。

### 当前 deployed 登录态
AuthGate = Mode A（免登→失败显原因+detail）；扫码按钮代码还在但**用户要求弃用**，A 落地后应移除扫码入口。

### 不做
- ❌ 扫码（用户否决）。
- ❌ 直接信任 `X-Bitable-Open-Id` 当登录（不可验证，违 CLAUDE.md）。

### 研究结论（2026-06-23，子代理调研，高置信度）
**A 结构性死路。** 一手证据 = `@lark-base-open/js-sdk@1.0.2` 的 `dist/index.d.ts`：`bridge` 全部方法穷举无一返回可验证凭证。`getUserId`(已废弃)/`getBaseUserId`/`getTenantKey` 都是可伪造裸 id；唯一像 token 的 `getPersonalBaseToken()` 是**需用户手动在 Base UI 点击生成**的长期 server-side API token（验证的是 token 持有、非"此刻登录人"，且非零点击）。`authcode/requestauthcode/ticket/access_token/signature/jsapi` 在整个 dist grep 零命中。根因：飞书把"H5 网页应用 JSAPI 免登(h5sdk/tt)"和"Base 扩展 SDK(bridge)"做成两套互不相通运行时，Base 扩展 iframe 不注入 h5sdk、bridge 又刻意不给换码/验签。**"零点击+可验证+不扫码"三者不可兼得 = 飞书硬边界。**
- 文档：bridge 全量 https://lark-base-team.github.io/js-sdk-docs/zh/api/bridge ；网页应用免登(不适用Base) https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/web-app-resource-introduction/utilize-jsapi
- 证据文件：scratchpad `package/dist/index.d.ts`（bridge 接口 L461-486 / L3033-3059）。

### 决策：实装 B（OAuth handoff，非扫码，一次点击，可验证）
用户「永不扫码」+ A 死路 → B 是唯一可行的可信链路。形态：**点「飞书登录」→ 系统浏览器跑标准飞书 OAuth 授权（authen/v1/authorize → code → 后端换 user_access_token，已有路由）→ 把会话带回 Base iframe**。
- **难点 = 会话回传 iframe**：系统浏览器与飞书桌面 webview 不共享 cookie/localStorage。**解法 = handoff-code 轮询（类 device-flow，规避 cookie 隔离）**：
  1. 前端 POST `/api/auth/feishu/fbif/handoff/start` → 后端建 handoff 记录 `{code=crypto随机, status=pending, exp=5min, sessionToken=null}` → 返回 code。
  2. 前端开系统浏览器到 `/auth/feishu/fbif/login?handoff=<code>`（code 进**签名 state**，防伪造）。
  3. OAuth 在浏览器完成 → `finalizeTrustedLogin` 建 session → **同时**把 sessionToken 写进该 handoff 记录、status=done。
  4. 前端轮询 `GET /api/auth/feishu/fbif/handoff/:code`（~2s）→ done 后返回 sessionToken → 存 localStorage(X-Session-Token) → 登录态成立。
  5. **安全**（避开旧 `/start`+`/login-status` 被下线的"session 接管风险"）：code crypto 随机不可猜、**单次消费**、5min 过期、与 state 签名绑定、handoff 记录只在 done 后短窗内可取一次。
- 存储：handoff 记录可先用**内存 Map + 定时清理**（够用、无需 migration）；生产多实例时再落库（当前单实例，内存够）。
- 复用：`createSignedState/verifySignedState`、`finalizeTrustedLogin`、`upsertSession`、前端 `authSessionToken.ts` 全复用。
- 完成后：**移除扫码入口**（AuthGate + NewTemplateScreen 的扫码按钮/QR），改为「飞书登录」单按钮 + handoff 轮询。

### 不做
- ❌ 扫码（用户否决）。❌ A（不可行）。❌ 信任裸 open_id 当登录。

### 待办（goal 驱动，逐项闭环）
- [x] B-后端：handoff 内存存储 + `POST handoff/start` + `GET handoff/:code` + `login` 路由读 handoff state + `finalizeTrustedLogin` 回写 handoff。
- [x] B-前端：AuthGate/NewTemplateScreen 改 handoff 流（开浏览器 + 轮询）；移除扫码。
- [x] tsc + build + 测试（含脆弱源码断言同步）。
- [ ] /codex:review 审查 → 按结果+判断改。（用户负责）
- [ ] 部署 → 真机验证（系统浏览器回跳 + handoff 轮询拿回会话）。（用户负责）

### 实装记录（2026-06-23，handoff 落地）
- 新建 `server/src/authHandoff.ts`：内存 Map handoff 存储。`HANDOFF_TTL_MS=5min`；
  `createHandoff()`(crypto 32B hex code)/`completeHandoff(code,token)`/`consumeHandoff(code)`(done 后单次消费即删)；
  `pruneExpired(now?)` 在每次 create/complete/consume 顺带调用（无 setInterval）；`__resetHandoffStoreForTest()` 仅测试。
  过期测试钩子：`pruneExpired(now)` 接受可选 now，测试传未来时间触发过期，不脏化生产 API。
- `authSessionRoutes.ts`：
  - `OAuthStatePayload` 加可选 `handoff?`；`createSignedState(...,handoff?)` 仅有值时进 payload（自动签名）。
  - 新增 `decodeSignedStatePayload()` 复用 `verifySignedState` 校验后返回 payload；`verifySignedState` 改为它的 `!==null` 包装（不破坏 callback/qr-callback）。
  - `/auth/feishu/:appKey/login` 读 `query.handoff`（>128 视为无效忽略）传入 state。
  - `finalizeTrustedLogin(...,handoffCode?)`：成功 upsertSession+建 token 后、return 前若有 handoffCode 调 `completeHandoff`。仅 OAuth callback 传，client-code/qr-callback 不传。
  - callback 用 `decodeSignedStatePayload` 取 handoff 传入。
  - 新增 `POST /api/auth/feishu/:appKey/handoff/start`（返回 code+expiresIn:300, no-store）、`GET /api/auth/feishu/:appKey/handoff/:code`（hex64 校验, consumeHandoff, no-store），放在两条 410 兜底之前。
- 前端 `feishuTrustedLogin.ts`：加 `startOAuthHandoff()`(POST start + window.open login?handoff=)、`pollOAuthHandoff(code)`；
  移除 `fetchTrustedLoginQrGoto`/`mountTrustedLoginQr`/`FEISHU_QR_SDK_URL`/`QRLogin`/`qrSdkLoadPromise`。
- `App.tsx` AuthGate：phase `'qr'`→`'waiting'`；主按钮「飞书登录」走 `startHandoffLogin()`（开浏览器+2s 轮询，done→存 token→onReady；超时 5min/连续失败报错可重试）；次按钮「重新尝试免登」。
- `NewTemplateScreen.tsx`：去扫码；`loginPrompt.phase` 用 `'waiting'`；主按钮「飞书登录」走 handoff，done 后 `retrySaveAfterLoginRef` 继续 `saveTemplate()`；保留 detail + 「重新尝试飞书免登」。
- 测试：新增 `server/src/authHandoff.test.ts`（create→pending/complete→done/单次消费/过期/未知）；
  `sidebarResponsiveLayout.test.ts` 扫码断言改 handoff 锚点（`飞书登录`/`startOAuthHandoff`/`重新尝试飞书免登`），保持意图。

### 三项校验结果（2026-06-23，全绿）
- typecheck：`tsc --noEmit` 0 错误。
- build:web：`vite build` 通过（chunk size 警告为既有，无关）。
- tests：`# tests 314 / # pass 314 / # fail 0`。
- 偏离 spec：(1) consumeHandoff 内 prune 顺序——spec 写"开头 prune 后判断"，但开头 prune 会把
  已过期的目标 code 删掉导致永远走 unknown、expired 不可达（spec 自身张力）。改为先单独判定目标
  code（过期→删它返回 expired），再 prune 其余项，使 expired 可达且语义更准。(2) 顺带把
  feishuTrustedLogin.ts 的 STAGE_REASONS 文案"改用扫码登录"改成"点击下方飞书登录"（扫码入口已删，
  原文案会指向不存在的入口，属我的改动引入的不一致，按规则三清理）。

## open_id 绑定加固（2026-06-23）

### 背景：会话接管风险
原 handoff（前端建 code → 开系统浏览器跑 OAuth → 轮询取 sessionToken）有**会话接管风险**：
攻击者建 code → 钓鱼受害者完成 OAuth → 受害者 token 落进该 code → 攻击者轮询偷走。

### 加固机制（open_id 绑定）
- `handoff/start` 强制读 `X-Bitable-Open-Id`（发起者 Base 身份），空 → 400「缺少 Base 身份」，
  不建无主 handoff。`createHandoff(expectedOpenId)` 把它绑进记录。
- OAuth 在系统浏览器完成后，`finalizeTrustedLogin` 调 `completeHandoff(code, token, userInfo.open_id)`：
  只有 OAuth 完成者 open_id **严格等于** expectedOpenId 才写 token（status=done）；否则置 status=rejected、
  留存 actualOpenId，**不发 token**。
- handoff 状态扩展 `'pending'|'done'|'rejected'`；`consumeHandoff` 对 rejected 单次返回
  `{reason, expectedOpenId, actualOpenId}` 后删除（供诊断）。前端轮询 rejected → 停止 + 显原因 +
  detail 拼两个截断 open_id（`mismatch: base=… vs oauth=…`）+ 允许重试。
- 顺带 codex 3 个 Medium：M1 路由正向 smoke 测试；M2 生产缺 `OAUTH_STATE_SIGNING_SECRET` 模块加载时
  `console.error` 响亮告警（不 crash）；M3 login 路由 `query.handoff` 改 hex64 格式校验（与 handoff/:code 对齐）。

### 头号真机验证项（必须真机确认）
**Base bridge `getUserId()` 的 open_id 是否等于 OAuth app 的 open_id。** 飞书 open_id 按应用隔离，
Base 扩展 SDK 的 open_id 与 FBIF OAuth app 的 open_id **可能不是同一命名空间**。若不同，严格相等会把
**正常登录误判成 rejected**。因此 mismatch 时刻意**不静默**：后端日志打 actual(OAuth) open_id +
说明，前端 detail 同时显示两个截断 open_id。真机看到 rejected 时据此区分：
- base 与 oauth 两个 id 明显不同且都是"自己" → **应用隔离误伤**，需放宽比对策略（如改比对其他可验证字段）。
- base 是自己、oauth 是陌生 id → **真防住了接管攻击**。

### 旧调用方兼容
client-code / qr-callback 路由调 `finalizeTrustedLogin` **不传 handoffCode**，completeHandoff 不触发，
行为完全不变。

### 三项校验结果（2026-06-23，全绿）
- typecheck：`tsc --noEmit` 0 错误。
- build:web：`vite build` 通过（chunk size 警告为既有，无关）。
- tests：`# tests 319 / # pass 319 / # fail 0`。
- 偏离 spec：后端 mismatch 日志只打 actual(OAuth) open_id（expected 由 handoff/:code 的 rejected 响应连同
  actualOpenId 一并回前端 detail）——因 spec 把 `completeHandoff` 返回值严格限定为 `{matched}`，
  日志处拿不到 expectedOpenId。前端 detail 完整暴露两个 id，满足"真机可区分"核心目标。

### Codex 审查结论（2026-06-23）
- 无 Critical。1 条 High = OAuth callback 的 `#session_token` redirect（**既有架构**问题，handoff 未新增也未消除；hash 不发服务器，暴露面小于 query；记为已知风险）。3 条 Medium 已全修（M1/M2/M3）。
- **Codex 漏判、我独立发现并已加固**：会话接管/登录 CSRF（攻击者建 code→钓鱼受害者完成 OAuth→偷会话）= 旧 handoff 被 410 下线的原因本身。已用 open_id 绑定加固（用户拍板）。

### 部署 + 上线验证（2026-06-23 → 24）
- commit `3fbd22a` push main → GitHub Actions 部署成功（Test+Build+Deploy On Server 全过，37s）。
- 线上 bundle `index-Dqsr7h1j.js`：handoff 锚点在线、**扫码 0 残留**；`POST .../handoff/start` 不带 `X-Bitable-Open-Id` 返回 **400**（open_id 绑定强制生效）。

### 状态：✅ 自动可完成部分全部闭环；⏳ 仅剩真机验证（需用户）
飞书桌面 Base 侧边栏点「飞书登录」实测：① window.open 能否唤起系统浏览器跑 OAuth 并回跳；② handoff 轮询能否拿回会话（rejected 则看 detail 两个 open_id 判断"防住接管"vs"应用隔离误伤"）；③ 成功后自动进插件/继续保存。
