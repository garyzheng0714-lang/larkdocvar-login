# 重构进度（样式不统一根因治理 + 可靠性 + 可维护性）

> 背景：8 个 agent 并行审查发现，"Word 导入后样式和最终效果不统一"的根因是
> 手写正则改 OOXML `<w:t>` 节点做变量替换（split-run 样式塌缩）。
> 选型实测后用 **easy-template-x + run 归一化** 替换（docx-templates 因把 `{{}}` 当 JS
> 表达式、对任意字段名报错而弃用）。整体分 5 个阶段推进。

## 阶段状态

| 阶段 | 内容 | 状态 | Commit |
|---|---|---|---|
| **0 止血护栏** | CI 测试门禁 / ErrorBoundary / image 误判修复 / 错误文案带变量名 / accept 纯 docx / ETA 去魔法值 | ✅ 完成 | `3735b51` |
| **1 换引擎** | easy-template-x + run 归一化重写 Docx 渲染（默认启用，env=legacy 回退）；脚注兜底；缩略图修复；飞书路径 split-run 样式修复 | ✅ 完成 | `3ceb444` `465bdc9` `e16e9c4` |
| **2 可靠性** | pg 连接池上限✅；模板归属/owner_key 隔离✅；render_jobs 落库 + 心跳续租 + markStale 按租约回收✅。**但**「DB 驱动队列」实为 DB 持久化的进程内异步任务（setImmediate 执行，无独立 worker 拉取、无 cancel 端点、无 owner-scoped CAS，单实例模型）；**且前端尚未接入**——侧边栏生产路径仍走同步 `/document-renders/batch` | 🔶 后端就绪 / 队列前端未接入 | `8a1fa8c` `bd8f0af` `8f61de3` |
| **3 信任体验** | 「留空继续」前后端真贯通✅。Gotenberg PDF 预览：后端 `convertDocxToPdfPreview` + `includePdfPreview` 契约 + docker-compose `gotenberg` 服务均就绪✅（业务系统经 API Key 调 `includePdfPreview` 即可用；e2e docx→pdf 转换需真实 `docker compose up` 验证，本机无 docker 未跑）；**仅侧边栏前端无预览入口未接** | 🔶 留空继续完成 / PDF API 可用·侧边栏未接 | `1af644c` |
| **4 可维护性** | 拆分 documentRenderApi.ts / PrimaryScreen.tsx；清 _components.css 死类；抽 useBatchRunner 复用开始生成和重试路径 | ✅ 完成 | `3671b3d` |
| **收尾** | 同步 docs/docx-api-integration.md（含更新日志）+ CONTEXT.md ✅（机器可验）。线上飞书云文档同步、Chrome 真实页面验证属人工/外部项，见下「最终验证记录」如实标注 | 🔶 文档同步完成 / UI 与飞书同步待复验 | 收尾提交 |

## 关键决策（详见 agent 记忆 project_docx-render-engine-choice）

- **渲染引擎**：easy-template-x（`delimiters {{ }}`），非 docx-templates。
- **样式保真策略**：替换前把 `{{变量}}` 涉及的相邻 run 的 rPr 统一为「变量名主体重叠字符最多的 run」的样式，再交给 easy-template-x。Docx 与飞书两条路径同思路。
- **feature flag**：`DOCUMENT_RENDER_TEXT_ENGINE=legacy` 可回退旧手写引擎兜底。

## 第二轮审计与修复（2026-06-02，7 个 agent 并行核验声明 vs 实际代码）

第一轮收尾把若干阶段标成「✅ 完成」存在**过度声称**。第二轮审计逐项核对后如实修正，并修掉发现的真 bug：

- 🔴 **残留占位符误判 bug（已修 `277f753`）**：`hasResidualPlaceholders` 此前对替换后文本裸扫 `includes('{{'||'}}')`，用户值里含字面孤立 `{{`/`}}`（公式 `f(x)}}`、代码、JSON、模板示例）会被误判为「模板仍有未替换占位符」致整单失败。改为只认完整 token `/\{\{[^{}]*\}\}/`（含空占位 `{{ }}`），孤立字面括号不再误杀；补回归测试。
- 🟠 **CI 测试门禁前端盲区（已修 `04ba73d`）**：`package.json` test glob 只匹配 `server/src/**`，`src/` 下 4 个前端测试（15 用例）从不执行。已并入同一 `npm test`，全量 227→243 全绿。
- 🟠 **render job markStale 误杀窗口 + 占位测试（已修 `8f61de3`）**：续租只在每条记录完成后发生，单条耗时超 15min lease 会被误判 stale；加心跳续租消除窗口。占位式常量断言测试换成真实行为测试（markStale 不误杀新鲜租约、owner 不串号）。
- 🔶 **如实降级（本提交）**：阶段 2「DB 驱动队列」与阶段 3「Gotenberg 保真预览/PDF 导出」前端均未接入、Gotenberg 编排无服务，从「✅ 完成」降为「后端契约就绪 / 前端未接入」，与任务 #9 对齐。

仍未做（按优先级与产品取舍待定，不冒充已完成）：

- 队列接入前端（提交→轮询→拉结果）或保持后端 API 供业务系统调用；lease 的 owner-scoped 原子 CAS（多实例严格防抢占）。
- Gotenberg：docker-compose 增服务 + 前端预览入口（若产品确定要面向侧边栏用户交付 PDF 预览）。
- ETA 估算抽纯函数补测；`useBatchRunner.ts` 名实不符（纯函数 `runBatchSlices`）建议改名 `batchRunner.ts` 并补中断/暂停语义测试。

## 已知技术债 / 后续

- 飞书路径还有：图片替换 N+1 重拉文档、批量串行、错误吞掉 logId、识别(raw_content)与替换(单 block)扫描口径不一致——审查 high/medium，未纳入本轮 5 阶段，待评估。
- CSS 静态扫描仅保留 `cloud-notice-info/success` 两个动态拼接类；后续如新增动态类，需要在扫描规则中显式白名单。
- 真实 Word 打开的像素级保真验证依赖阶段 3 的 Gotenberg 预览服务可用性。

## 最终验证记录

- `npm run typecheck` ✅
- `npm test` ✅ 243/243（含第二轮新纳入的前端 `src/` 测试与新增回归测试）
- `npm run build:web` ✅
- `git diff --check` ✅
- Chrome 真实页面验证 ✅（2026-06-02 本轮真实复验，`http://127.0.0.1:5173/?mock=1`）：
  - Word 文档路径：模板卡片、字段映射 8 行（字段/固定值切换 + 下拉 + 智能匹配）、文件命名 token 编辑器、写回字段、生成数量、高级设置（下载有效期 + 缺失变量时「留空继续」默认值）均渲染正常、对齐良好、无裁切重叠；控制台无报错。
  - 完整生成流程：点「开始生成」→ 进度弹窗（进度条/✓成功·失败·进行中·待处理计数/逐条记录状态/终止·暂停按钮/「预计还需 N 秒」实测 ETA）→ 完成态（100%、6 成功 0 失败、关闭按钮）逐帧正常，底栏文案随状态正确切换。
  - 飞书云文档路径：链接输入 + 提取变量按钮、底栏「请先提取变量 / 开始替换（置灰）」空状态正常。
- 线上飞书云文档同步：⏳ **待确认**。仓库内无指向云文档 token 的同步脚本，第一轮「已同步」无法核验；按红线应补一个走飞书开放平台 API 的同步脚本固化流程。
