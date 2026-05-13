# Docx API 里程碑 1 验收审计

更新时间：2026-05-12

## 目标

传入一个 Docx 模板链接和变量，API 稳定返回可下载的最终 Docx。

## 当前结论

里程碑 1 当前验收通过。本次完整验收使用火山引擎 TOS 作为生产对象存储链路，API 返回 `storage=tos` 的带有效期下载链接，不返回本地临时链接。

- 完整验收命令：`DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:document-render-milestone1`
- 同次运行 ID：`milestone1-1778544595443-e399df2184408`
- API 验收报告：`/tmp/larkdocvar-document-render-latest-report.json`
- 对象存储预检报告：`/tmp/larkdocvar-oss-latest-report.json`
- 密钥扫描报告：`/tmp/larkdocvar-secrets-latest-report.json`
- 客户端打开报告：`/tmp/larkdocvar-docx-client-latest-report.json`
- 飞书导入报告：`/tmp/larkdocvar-feishu-import-latest-report.json`
- 最终审计报告：`/tmp/larkdocvar-milestone1-audit-latest-report.json`

## 本次验收结果

| 要求 | 本次证据 | 状态 |
|---|---|---|
| 生成后的 Docx 上传到对象存储 | 真实 TOS 预检包含 `put-ok`、`signature-url-ok`、`download-ok`、`delete-ok` | 通过 |
| API 返回对象存储下载链接 | API 报告 `storage=tos`，审计门禁 `API 返回 OSS 下载链路` 通过 | 通过 |
| 下载链接有效期可配置 | API 验收包含 `download-ttl-ok`；测试覆盖 1 小时默认、24 小时单次配置和超限拒绝 | 通过 |
| 本地无对象存储配置才降级 local | 测试覆盖无配置 local、不完整 OSS/TOS 配置拒绝降级、上传失败拒绝降级 | 通过 |
| 支持正文、表格、页眉、页脚变量 | Docx 范围测试和 API 验收均通过 | 通过 |
| 支持变量被 Word 拆成多个文本节点 | 普通拆分变量、表格拆分变量、页眉页脚拆分变量测试通过 | 通过 |
| 替换后保留基础样式 | 加粗、颜色、字号、表格边框、拆分 run 起始样式检查通过 | 通过 |
| 至少 20 份不同结构模板回归 | 20 个业务模板回归和 `docs/docx-regression-template-library.json` manifest 校验通过 | 通过 |
| 所有已传变量必须被替换 | API 验收包含 `variables-replaced` 和 `no-placeholders` | 通过 |
| 未传变量返回 `missingVariables` | API 验收包含 `missing-variables-ok`，缺变量时不保存半成品 | 通过 |
| 生成文件可被客户端打开 | WPS 实际打开通过；`textutil` 可解析；未出现损坏提示 | 通过 |
| 飞书文档打开不报错 | 飞书 execute 导入实际通过，返回导入结果 | 通过 |
| 生成后文件里不得残留 `{{变量}}` | API 验收和回归测试均检查无残留占位符 | 通过 |
| 单个模板最大支持 20MB | 接近 20MB 合法模板生成通过，超限模板拒绝 | 通过 |
| 单次生成 p95 小于 5 秒 | 连续生成 p95 189ms，并发生成 p95 306ms | 通过 |
| 连续生成 500 次无崩溃 | 500/500 成功，max 272ms | 通过 |
| 并发 20 个请求成功率 99% 以上 | 20/20 成功，max 571ms | 通过 |
| 默认禁止内网、本机、云元数据模板链接 | 本机、内网、链路本地、云元数据、IPv6 映射和非常规 IP 编码测试通过 | 通过 |
| 禁止非 HTTPS 模板链接 | 默认拒绝 HTTP；本地实验显式开启时才允许 | 通过 |
| 防 zip bomb、坏 Docx、伪装 Docx | 解压体积、zip 条目数量、坏 Docx、伪装 Docx 测试通过 | 通过 |
| 错误信息不暴露内部堆栈 | 参数错误、JSON 错误、请求体过大、内部异常、对象存储失败均返回用户可理解错误 | 通过 |
| README 有可复制 curl 示例 | README 检查项通过 | 通过 |
| README 有成功/缺失变量/模板损坏/对象存储缺失示例 | README 检查项通过 | 通过 |
| 返回字段稳定 | `ok`、`document`、`variables`、`download`、`requestId` 契约测试通过 | 通过 |
| 密钥不进入受版本管理文件 | `verify:secrets` 通过，仅输出变量名和文件路径，不输出密钥值 | 通过 |

## TOS 适配说明

本项目仍保留阿里云 OSS 支持，同时新增火山引擎 TOS 支持。生产对象存储通过以下变量选择：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos
TOS_ACCESS_KEY=...
TOS_SECRET_KEY=...
TOS_BUCKET=...
TOS_REGION=cn-beijing
TOS_ENDPOINT=tos-cn-beijing.volces.com
DOCUMENT_TOS_ROOT_PREFIX=fbif-sidebar-docgen/prod
DOCUMENT_RENDER_TOS_PREFIX=renders
```

推荐同时配置 `DOCUMENT_TEMPLATE_TOS_PREFIX=templates`，让模板资产和生成结果在同一个 TOS bucket 根目录下按 `templates/`、`renders/` 分开管理。未配置 `DOCUMENT_TOS_ROOT_PREFIX` 时仍兼容历史根目录前缀。

实现没有引入 `@volcengine/tos-sdk` 生产依赖，避免把临时验证 SDK 带来的高危依赖审计项带入项目。生产代码使用 TOS4 签名：上传用 `Authorization: TOS4-HMAC-SHA256 ...`，下载用 `X-Tos-Algorithm`、`X-Tos-Credential`、`X-Tos-Date`、`X-Tos-Expires`、`X-Tos-SignedHeaders`、`X-Tos-Signature` 预签名参数。

本次真实预检已证明当前 TOS 配置可以完成上传、签名下载、字节校验和删除。此前失败的 TOS 配置应视为凭证、bucket 或权限配置问题，不是 TOS 链路不可用。

## 复验命令

```bash
npm test
npm run typecheck
npm run build
npm run verify:secrets
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:oss
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:document-render-milestone1
npm run audit:document-render-milestone1
git diff --check
npm audit --omit=dev --audit-level=high
```

验收脚本会自动生成同一个 `DOCUMENT_RENDER_MILESTONE1_RUN_ID`，并要求对象存储、密钥扫描、API、客户端打开、飞书导入和最终审计报告来自同一次运行，避免拼接旧报告误判完成。
