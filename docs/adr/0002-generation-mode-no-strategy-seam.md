# ADR-0002：两种生成模式暂不引入 GenerationStrategy seam

- 状态：已接受
- 日期：2026-05-30

## 背景

架构 review 提出候选「为飞书云文档模式（`CloudDocGeneratorApp`）与 Docx 模板资产模式（`DocumentGeneratorApp`）抽一个 `GenerationStrategy` 接口，两模式各做 adapter，工厂按 kind 选，替换 App 顶层的 `if (generatorKind === 'feishu')` 分叉」。

现状：模式切换是 App 顶层一个条件分叉，两个组件接收同一组 props 但各自忽略一半（云文档侧忽略 `templates/runner`，Docx 侧忽略 `selectedRecordIds/refreshBitable`）。

## 决策

暂不引入 `GenerationStrategy` 接口。维持顶层条件分叉。

## 理由

1. 当前只有两种生成模式，且没有第三种的需求。引入 strategy 接口是为不存在的扩展性买单，违反「简单至上」——只有两个 adapter 且其中一种永不新增时，抽象接口的杠杆为负。
2. 纯前端结构性重构需通过真实浏览器/飞书侧边栏验证（见仓库 UI 验证约定）；在「只跑本地单测/构建」约束下无法验证 strategy 切换后的渲染行为正确，盲改风险高。
3. 两模式真正可在本地安全收敛的，是其中的纯逻辑。字段名归一化和候选字段筛选已收敛到 `fieldMatching.ts`，但两侧仍保留各自的匹配策略：Docx 模板侧优先精确字段名再回退 `suggested`，云文档侧使用归一化精确匹配并允许包含匹配。取值逻辑仍由云文档侧的 `cloudFieldMapping.ts` 承担。

## 重新审视的条件

当出现第三种生成模式（如 PDF、Google Docs），或两模式的 props 契约冲突造成实际维护痛点时重开——届时 strategy seam 有真实杠杆，且应在可真实验证侧边栏渲染的环境下进行。
