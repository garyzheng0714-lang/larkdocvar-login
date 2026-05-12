# Docx API 运维手册

更新时间：2026-05-12

## 必备环境变量

### 鉴权

| 变量 | 必需性 | 说明 |
|---|---|---|
| `DOCUMENT_RENDER_API_KEY` | 建议生产配置 | 服务端到服务端 API Key。配置后业务系统需传 `Authorization: Bearer` 或 `x-api-key`。 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 侧边栏必需 | 飞书登录和云文档模板路径使用。 |
| `DATABASE_URL` | 侧边栏必需 | 保存登录会话和飞书云文档模板配置。 |

### 生成文件存储

| 变量 | 说明 |
|---|---|
| `DOCUMENT_RENDER_STORAGE_PROVIDER` | 可选 `oss` 或 `tos`；同时配置 OSS/TOS 时建议显式填写。 |
| `DOCUMENT_RENDER_OSS_ACCESS_KEY_ID` / `DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET` / `DOCUMENT_RENDER_OSS_BUCKET` / `DOCUMENT_RENDER_OSS_REGION` | 阿里云 OSS 生成文件存储。 |
| `TOS_ACCESS_KEY` / `TOS_SECRET_KEY` / `TOS_BUCKET` / `TOS_REGION` / `TOS_ENDPOINT` | 火山引擎 TOS 生成文件存储，也可复用为模板存储。 |
| `DOCUMENT_RENDER_DOWNLOAD_TTL_SECONDS` | 默认下载链接有效期，建议用秒。 |
| `DOCUMENT_RENDER_PUBLIC_BASE_URL` | 需要返回绝对下载 URL 时配置。 |

### 模板资产存储

| 变量 | 说明 |
|---|---|
| `DOCUMENT_TEMPLATE_STORAGE_PROVIDER` | 可选 `tos`。为空时会跟随 `DOCUMENT_RENDER_STORAGE_PROVIDER`。 |
| `DOCUMENT_TEMPLATE_TOS_PREFIX` | 模板资产前缀，默认 `document-templates`。 |
| `DOCUMENT_TEMPLATE_STORAGE_DIR` | 本地开发模板存储目录；生产环境不能依赖它。 |
| `DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS` | 仅本地实验使用；生产不要开启。 |

## 本地启动

```bash
cp .env.example .env
npm install
npm run dev
```

开发服务：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`
- 健康检查：`http://localhost:3000/api/health`

## 冒烟检查

```bash
npm test
npm run build
npm run verify:secrets
git diff --check
```

对象存储预检：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:oss
```

如果需要把 OSS 配置写入本机私有 `.env.local`，可以使用配置脚本。脚本只输出写入了哪些字段，不会打印 AccessKey 值；生成的 `.env.local` 会被 git 忽略，并设置为仅当前用户可读写。

```bash
npm run configure:oss-local <<'EOF'
DOCUMENT_RENDER_OSS_ACCESS_KEY_ID=your_access_key_id
DOCUMENT_RENDER_OSS_ACCESS_KEY_SECRET=your_access_key_secret
DOCUMENT_RENDER_OSS_BUCKET=your_bucket_name
DOCUMENT_RENDER_OSS_REGION=cn-beijing
EOF
```

也兼容常见 OSS 别名：`ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET` / `ALIYUN_OSS_BUCKET` / `ALIYUN_OSS_REGION`，以及 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_BUCKET` / `OSS_REGION` / `OSS_REGION_ID`。如果同时存在 OSS 和 TOS 配置，用 `DOCUMENT_RENDER_STORAGE_PROVIDER=tos` 或 `DOCUMENT_RENDER_STORAGE_PROVIDER=oss` 显式选择。

### OSS 预检失败

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| `NoSuchBucket` | bucket 名称写错、region 不匹配，或该 AccessKey 所属账号看不到这个 bucket。 | 在阿里云 OSS 控制台确认 bucket 名称和地域；`DOCUMENT_RENDER_OSS_REGION` 可以写 `cn-beijing` 或 `oss-cn-beijing`。 |
| `InvalidAccessKeyId` | AccessKey 不存在、已禁用，或不属于可访问该 bucket 的账号。 | 在 RAM/AccessKey 管理页面确认 AccessKey 状态为启用，并确认它属于拥有目标 bucket 权限的账号。 |
| `AccessDenied` | AccessKey 有效但权限不足。 | 给该 AccessKey 对目标 bucket 的 `PutObject`、`GetObject`、`DeleteObject`、`ListBuckets` 或等效最小权限。 |
| `SignatureDoesNotMatch` | Secret、region 或签名参数不匹配。 | 重新写入 AccessKey Secret，并核对 bucket region。 |

OSS 最小权限：

| 项目 | 必需性 | 说明 |
|---|---|---|
| 目标 bucket 已存在 | 必需 | `DOCUMENT_RENDER_OSS_BUCKET` 必须是当前 AccessKey 所属账号可访问的真实 bucket。 |
| bucket 地域匹配 | 必需 | `DOCUMENT_RENDER_OSS_REGION` 必须和 bucket 地域一致。 |
| AccessKey 状态启用 | 必需 | RAM/AccessKey 页面中该 AccessKey 必须为启用状态。 |
| `PutObject` | 必需 | 允许写入 `DOCUMENT_RENDER_OSS_PREFIX` 下的生成文件和预检文件。 |
| `GetObject` | 必需 | 允许通过签名 URL 下载刚生成的 Docx。 |
| `DeleteObject` | 必需 | 允许预检脚本删除诊断文件，避免留下测试对象。 |
| `ListBuckets` | 仅诊断 | 只用于失败时生成可读诊断；没有这个权限时，真实 put/signature/download/delete 通过仍可完成 OSS 链路验收。 |

Docx 里程碑完整验收：

```bash
DOCUMENT_RENDER_STORAGE_PROVIDER=tos npm run verify:document-render-milestone1
npm run audit:document-render-milestone1
```

## 生产部署注意事项

- 生产环境必须配置模板 TOS 存储；缺配置时模板资产能力会返回可读错误。
- 生产环境必须配置生成文件 OSS/TOS 存储；不要让最终 Docx 落到本机临时目录。
- `index.html` 响应头应为 `Cache-Control: no-cache`；带 hash 的静态资源可长期缓存。
- API 错误响应不应包含堆栈、AccessKey、bucket 名称或内部路径。
- `.env.local`、部署密钥和真实 AccessKey 不允许提交到仓库。

## 常见故障

| 现象 | 排查 |
|---|---|
| 上传模板失败，提示非 HTTPS | 确认模板下载链接是 HTTPS；本地调试才可设置 `DOCUMENT_TEMPLATE_ALLOW_PRIVATE_URLS=true`。 |
| 上传模板失败，提示内网地址 | 模板链接不能指向本机、内网或云元数据地址。 |
| 生成失败，返回 `missingVariables` | 请求变量缺少模板中存在的字段，补齐后重试。 |
| 生成失败，返回 `unusedVariables` | 请求变量名和模板变量不一致，检查大小写、空格和中文名。 |
| 生产环境返回对象存储配置错误 | 检查 OSS/TOS 四件套：AccessKey、Secret、Bucket、Region。 |
| 侧边栏能登录但 Docx API 401 | 如果开启 `DOCUMENT_RENDER_API_KEY`，确认侧边栏请求仍带登录 Cookie；业务系统必须带 API Key。 |
| 异步任务查询 404 | 当前任务状态是进程内存，服务重启后不会保留历史任务。 |

## UI 验证要求

涉及 `src/SidebarApp.tsx`、样式、布局、图标的修改，必须：

1. 启动本地服务前检查端口是否占用。
2. 用 `curl -s <url> | grep '<title>'` 确认页面属于当前项目。
3. 用真实浏览器或 Playwright 打开页面。
4. 检查桌面和移动宽度下的模板库、字段映射、按钮、空状态、错误状态。
