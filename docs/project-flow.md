# 项目流程文档：FBIF 参展合同自动生成

> 📎 线上飞书云文档：https://foodtalks.feishu.cn/docx/I7oydxZjYo7hXUxgIG2cghyznuh （本文件为仓库内同源版本，改动后需同步线上）
>
> 本文档梳理「飞书多维表格 → Docx API → 合同自动生成」的完整业务流程，并记录历次需求与变更。
> 面向业务/运维：搞清楚一份合同是怎么从勾选到生成的、新增模板要做什么、出问题查哪一环。
> 技术契约细节见 [docx-api-integration.md](docx-api-integration.md)。

## 更新日志

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-06-24 | 生成文件名修复 | 后端生成文件的对象存储 key 末段从 `requestId`(UUID) 改为 `{requestId}/{友好名}`，使「链接转附件」按下载链接末段取名时拿到中文合同名而非 UUID（已真机验证）。 |
| 2026-06-24 | 模板编号重排 | 6 个参展合同模板统一为 `tpl_001`~`tpl_006`（删除旧的 `tpl_20260529_*` 随机格式），同步模板登记表与 `templateId` 公式字段。 |
| 2026-06-23 | 多模板一套变量 | 后端新增 `unusedStrategy=ignore`：一个工作流用同一套 13 个变量喂 6 类模板，模板里没有的多余变量被忽略而非报错。 |
| 2026-06-23 | 6 模板上传 | 上传 6 个参展合同 `.docx` 到模板库（特装/标展/18㎡标展 × 有无渠道对接会门票）。 |

## 涉及资源

| 资源 | 标识 |
|---|---|
| 合同生成 Base | `VkvhbzKQ0aXH1us9D5scedzUni9` |
| └ 合同生成表 | `tblM5GeNSCN2YX6C` |
| └ 模板选项源表（「要用哪个合同模板」选项来源）| `tbljzpCPpEiKMCeX` |
| 模板登记表 Base / Table | `XLLwbL4RLahijwspSpLcLHc7nmc` / `tblKBewYJxZYG3Mm` |
| 合同生成工作流 | `wkfARsVClto74PlJ`（「【新】合同生成」）|
| 生产 Docx API | `https://fbif-sidebar-docgen.fbif.com/api/v1/document-renders` |
| templateId 公式字段 | `fld1iFjOFY`（合同生成表）|

## 模板编号映射

| templateId | 模板（「要用哪个合同模板」选项）| 变量数 |
|---|---|---|
| tpl_001 | 标展-9m² | 10 |
| tpl_002 | 标展-9m²-有渠道对接会门票 | 11 |
| tpl_003 | 标展-18m² | 10 |
| tpl_004 | 标展-18m²-有渠道对接会门票 | 11 |
| tpl_005 | 特装-默认 | 12 |
| tpl_006 | 特装-有渠道对接会门票 | 13 |

变量差异规律：核心 10 个变量所有模板共有；带「门票」版多 `渠道对接会门票数量`；特装版多 `展位宽度`、`展位长度`。

## 业务流程（两条分开的流程）

### 流程① 模板上传（建模板库，一次性）

```
.docx 模板 → POST /api/v1/document-templates（fileBase64）→ 存 TOS 模板资产 → 得 templateId
```

- 服务端上传时自动从模板提取 `{{变量}}`，返回 `versions[].variables`。
- 模板登记表 `tblKBewYJxZYG3Mm` 的「模板编号」记录每个模板的 templateId（已同步为 tpl_001~006）。

### 流程② 合同生成（每次勾选生成一份）

```
① 在合同生成表手动勾选「【新】生成文件」
     ↓ SetRecordTrigger（仅认人工勾选，不响应 OpenAPI 更新）
② [工作流 wkfARsVClto74PlJ]
     ├ HTTP 节点：POST /api/v1/document-renders
     │    · template.templateId = 公式字段 templateId（按「要用哪个合同模板」自动给出 tpl_00X）
     │    · variables：13 个字段引用
     │    · unusedStrategy:ignore + missingStrategy:blank（多余变量忽略、缺失按空）
     │    → 后端生成 docx 存 TOS，返回 download.url（末段=友好合同名）
     ├ 「FBIF-链接转附件」（独立自定义动作）：按 download.url 末段下载并命名附件
     └ 写回「【新】合同生成文件」附件字段
```

#### templateId 怎么动态选

合同生成表的 `templateId` 公式字段用 `SWITCH([要用哪个合同模板], ...)` 把选项映射到 tpl_00X，工作流 HTTP 的 templateId 引用它——所以**重排 templateId 只改这个公式字段，工作流不用动**。

#### 文件名为什么会「友好名 ↔ UUID」

「链接转附件」按**下载链接 URL 末段**给附件命名：

| 后端 download.url 末段 | → 附件名 |
|---|---|
| 旧：`{requestId}.docx`（UUID）| UUID |
| 新（2026-06-24 修复）：`{requestId}/{友好名}` | 中文合同名 |

## 已知约束 / 盲区

- **飞书工作流只认人工勾选**：触发器 `trigger_control_list` 为空，不响应 OpenAPI/批量更新（防循环保护）。用 API 改字段**触发不了**工作流，端到端测试只能在飞书界面手动勾选。
- **「FBIF-链接转附件」是独立自定义动作**：内部逻辑不在本工作流定义里，无法通过开放 API 查看或修改。
- **含 CustomAction 的工作流无法用开放 API 整体更新**（`workflow-update` 报 `step ... is not supported`）；这类工作流只能在飞书界面编辑。
- 工作流末尾「修改记录」节点建议补两个赋值（目前仅写附件）：复位「【新】生成文件」= 否、写「生成结果」状态。否则勾过的记录不会自动复位，重新生成需先手动取消勾选。

## 运维提示

- **新增一类合同模板**：上传 `.docx` 取得 templateId → 在「要用哪个合同模板」加选项 → 在 `templateId` 公式字段 `SWITCH` 加一条映射 → 工作流无需改动。
- **生成出错查哪一环**：附件名是 UUID → 查后端存储 key / 链接转附件；变量没填 → 查公式字段映射或合同生成表字段值；没生成 → 确认是人工勾选触发、工作流为启用状态。
