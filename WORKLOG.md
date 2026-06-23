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
- [ ] [task4] 文档同步飞书 + runbook 加 `DOCUMENT_RENDER_STRICT_CONFIG`/`render_audit`
- [ ] [task5] commit & push（注意甄别并发 agent 的登录重构改动）
- [ ] [task6] 部署生产 + 真机验证（含前端视觉）

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
