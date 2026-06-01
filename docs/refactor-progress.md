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
| **2 可靠性** | render_jobs DB 驱动队列（markStale 不误杀/租约/重试）；终止以批为粒度；模板归属隔离；pg 连接池上限 | 🚧 进行中 | — |
| **3 信任体验** | Gotenberg 保真预览/PDF 导出；"留空继续"贯通后端契约 | ⬜ 待开始 | — |
| **4 可维护性** | 拆分 documentRenderApi.ts(>900行)/PrimaryScreen.tsx；清 _components.css ~110 死类；抽 useBatchRunner 复用两条生成路径 | ⬜ 待开始 | — |
| **收尾** | 同步 docs/docx-api-integration.md（含更新日志）+ CONTEXT.md + 线上飞书云文档 | ⬜ 待开始 | — |

## 关键决策（详见 agent 记忆 project_docx-render-engine-choice）

- **渲染引擎**：easy-template-x（`delimiters {{ }}`），非 docx-templates。
- **样式保真策略**：替换前把 `{{变量}}` 涉及的相邻 run 的 rPr 统一为「变量名主体重叠字符最多的 run」的样式，再交给 easy-template-x。Docx 与飞书两条路径同思路。
- **feature flag**：`DOCUMENT_RENDER_TEXT_ENGINE=legacy` 可回退旧手写引擎兜底。

## 已知技术债 / 后续

- documentRenderApi.ts 暂超 900 行红线（加了新引擎），阶段 4 拆分。
- 飞书路径还有：图片替换 N+1 重拉文档、批量串行、错误吞掉 logId、识别(raw_content)与替换(单 block)扫描口径不一致——审查 high/medium，未纳入本轮 5 阶段，待评估。
- 真实 Word 打开的像素级保真验证依赖阶段 3 的 Gotenberg 预览。
