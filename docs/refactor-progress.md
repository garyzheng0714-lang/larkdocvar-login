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
| **2 可靠性** | pg 连接池上限✅；模板归属/owner_key 隔离✅。批量可靠性的**用户价值由侧边栏客户端编排交付**（`runBatchSlices` 客户端分批 + 实时逐条进度 + 暂停 + 终止，UI 实测可用）——经决策**保持此方案**（切服务端队列会失去暂停/终止粒度）。`render_jobs` 落库 + 心跳续租 + markStale 按租约回收定位为**业务系统 API 路径**的异步机制（非侧边栏缺口）；其多实例 owner-scoped CAS 见「仍未做」 | ✅ 用户可用（客户端编排）/ 队列服务 API 路径 | `8a1fa8c` `bd8f0af` `8f61de3` |
| **3 信任体验** | 「留空继续」前后端真贯通✅。Gotenberg PDF 预览：后端契约 + docker-compose `gotenberg` 服务 + **侧边栏「预览样式 PDF」入口**均已接✅（模板卡片下按钮→`includePdfPreview`→新标签打开 PDF；mock 下 UI 接线实测正常）。注：图片占位符不参与预览；真实 docx→pdf e2e 转换需部署侧 Gotenberg 实测（本机无 docker 未跑） | ✅ 留空继续 + 预览前端已接 / e2e 待部署侧实测 | `1af644c` `70b3a83` |
| **4 可维护性** | 拆分 documentRenderApi.ts / PrimaryScreen.tsx；清 _components.css 死类；抽 useBatchRunner 复用开始生成和重试路径 | ✅ 完成 | `3671b3d` |
| **收尾** | 同步 docs/docx-api-integration.md（含更新日志）+ CONTEXT.md ✅；Chrome 真实页面验证 ✅（第二轮实测）；线上飞书云文档核验+补漂移+固化同步脚本 ✅；origin 分歧已对齐 ✅。详见「最终验证记录」 | ✅ 完成 | 收尾提交 `7ab2d89` |

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

已据决策完成（第二轮）：

- 侧边栏批量**保持客户端编排**（实时进度+暂停+终止），`render_jobs` 队列定位为业务系统 API 路径机制——阶段2 用户价值视为已交付。
- Gotenberg PDF 预览：docker-compose 加 `gotenberg` 服务 + 侧边栏「预览样式 PDF」入口已接（`70b3a83`）。
- ETA 抽纯函数 `computeEtaSeconds` 补测、`runBatchSlices` 中断/暂停语义补测（`15fa2d4`）。

仍未做（低优先 / 待评估，不冒充已完成）：

- PDF 预览真实 docx→pdf e2e 转换需部署侧 Gotenberg 实测（本机无 docker）；图片占位符暂不参与预览。
- `render_jobs` 多实例 owner-scoped 原子 CAS（严格防抢占，需 PG 集成测试）——当前单实例模型够用。
- `useBatchRunner.ts` 名实不符（纯函数 `runBatchSlices`）可改名 `batchRunner.ts`；前端 image 判定与后端前缀常量可收敛去重；`documentRenderStorage` 配置缺失分支补直接单测。
- 飞书云文档同步已固化为 `scripts/sync-docx-api-doc.sh`；后续 API 文档变更后运行 `npm run sync:docx-api-doc -- --yes` 即可（无嵌入资源，overwrite 安全）。

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
- 线上飞书云文档同步 ✅（2026-06-02 第二轮核验）：`lark-cli docs +fetch` 拉线上文档与本地 `docs/docx-api-integration.md` 比对——基本一致（第一轮「已同步」基本属实），仅 2026-05-31 更新日志行漏了「租约」措辞，已用 `str_replace` 局部补齐（保留评论，未整篇 overwrite），线上现与本地完全一致。已新增 `scripts/sync-docx-api-doc.sh`（`npm run sync:docx-api-doc`）固化红线同步流程。
- origin 分歧 ✅：origin 的失败原因清晰化改进已手工移植到重构后结构（`593fecc`），并 `merge -s ours` 对齐（领先 22 / 落后 0）。
