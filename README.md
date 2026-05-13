# fbif-sidebar-docgen

![类型](https://img.shields.io/badge/%E7%B1%BB%E5%9E%8B-%E9%A3%9E%E4%B9%A6%E8%BE%B9%E6%A0%8F%E6%8F%92%E4%BB%B6-2563eb?style=flat-square)
![技术栈](https://img.shields.io/badge/%E6%8A%80%E6%9C%AF%E6%A0%88-React%20Express-0f766e?style=flat-square)
![状态](https://img.shields.io/badge/%E7%8A%B6%E6%80%81-%E5%8F%AF%E9%83%A8%E7%BD%B2-16a34a?style=flat-square)
![README](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-brightgreen?style=flat-square)

飞书插件：带 OAuth 登录的多维表格边栏插件，用于按云文档模板批量生成文档并将链接回写到表格。

## 仓库定位

- 分类：飞书多维表格边栏插件 / 云文档模板生成工具。
- 面向对象：需要从飞书云文档模板提取变量、批量套用多维表格记录并生成新文档的业务团队。
- 运行宿主：飞书多维表格边栏 iframe 插件，配套 Express 后端处理 OAuth、文档 API 和持久化。
- 与边栏插件合集的区别：本仓库是单一可部署插件应用，包含前端、后端、Docker 和部署脚本；插件合集仓库只集中管理多个独立子插件。

## 功能特性

- 飞书 OAuth 登录和会话保持
- 从飞书云文档 / Wiki 模板中提取 `{{变量}}`
- 自动匹配多维表格字段，并支持手动调整绑定
- 支持文本变量、链接字段和附件图片变量
- 批量生成全部记录或选中记录
- 自动创建 / 写回“生成文档链接”字段
- 支持协作者配置和文档所有权相关高级选项
- 支持模板配置历史和自动恢复
- 可选将用户配置同步到飞书多维表格
- 提供本地开发、Docker、本地预览和远程部署脚本

## 技术栈

- 前端：React、Vite、Tailwind CSS、lucide-react、`@lark-base-open/js-sdk`
- 后端：Express、TypeScript、tsx、Zod、Axios
- 存储：PostgreSQL
- 飞书能力：OAuth、云文档、Wiki、多维表格、用户目录
- 部署：Docker、Docker Compose、GitHub Actions

## 项目结构

```text
.
├── src/                         # React 边栏插件前端
├── server/
│   └── src/
│       ├── index.ts             # Express API 和 OAuth 会话
│       ├── feishu.ts            # 飞书文档 / 用户相关 API
│       ├── storage.ts           # SQLite 持久化
│       └── bitableConfigSync.ts # 可选的多维表格配置同步
├── scripts/
│   ├── dev-up.sh                # 本地开发启动脚本
│   └── deploy-fbif-sidebar-docgen.sh  # Docker 远程部署脚本
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 快速上手

插件内的基本流程：

1. 登录插件，右上角显示账号即表示成功。
2. 粘贴模板文档链接，点击“提取变量”。
3. 检查变量映射，必要时手动调整字段绑定。
4. 点击“全部生成”或“生成选中项”。
5. 系统生成文档并将链接写回多维表格。

模板权限说明：

- 模板变量提取使用当前登录用户的 OAuth token。
- 模板文档需要对实际使用插件的用户开放阅读权限。
- 飞书应用仍需要配置凭证，用于登录、文档和后续 API 能力。

## 本地开发

复制环境变量模板：

```bash
cp .env.example .env
```

填写飞书应用配置：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
PORT=3000
HOST=0.0.0.0
```

启动开发环境：

```bash
npm install
npm run dev
```

默认地址：

- 前端插件地址：`http://localhost:5173`
- 后端 API：`http://localhost:3000`
- 健康检查：`http://localhost:3000/api/health`

## 飞书 OAuth 配置

在飞书开放平台应用中添加 OAuth 回调地址：

```text
http://localhost:3000/api/auth/feishu/callback
```

本地 `.env` 中确认：

```bash
FEISHU_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/feishu/callback
FEISHU_OAUTH_SCOPE=contact:user.base:readonly drive:drive drive:file docx:document:readonly wiki:wiki
SESSION_COOKIE_NAME=larkdocvar_session
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAMESITE=lax
SESSION_MAX_AGE_SECONDS=604800
FRONTEND_POST_LOGIN_URL=http://localhost:5173
```

会话说明：

- 默认会话有效期为 7 天。
- 本地开发通常使用 `SESSION_COOKIE_SAMESITE=lax`。
- 跨站嵌入或 HTTPS 部署时，可按实际场景调整 SameSite 和 Secure 设置。

## 可选：多维表格配置同步

后端可将用户模板配置同步到飞书多维表格。需要在 `.env` 中配置：

```bash
BITABLE_SYNC_ENABLED=true
BITABLE_APP_TOKEN=base_app_token
BITABLE_TABLE_ID=table_id
BITABLE_SYNC_COOLDOWN_MS=60000
```

说明：

- `BITABLE_SYNC_ENABLED=false` 可关闭同步。
- `BITABLE_SYNC_COOLDOWN_MS` 用于限制频繁写入。
- 应使用部署环境自己的多维表格 App Token 和表 ID。

## API 概览

常用接口：

- `GET /api/health`：健康检查
- `GET /api/auth/feishu/login`：跳转飞书登录
- `GET /api/auth/feishu/callback`：OAuth 回调
- `GET /api/auth/session`：查询当前会话
- `POST /api/auth/logout`：退出登录
- `POST /api/template/variables`：提取模板变量
- `POST /api/documents/generate`：批量生成文档
- `GET /api/templates/saved`：模板配置历史
- `GET /api/configs/auto`：自动恢复配置
- `GET /api/users/search`：搜索用户，用于协作者和所有权配置

## Docker 本地运行

```bash
cp .env.example .env
docker compose up -d --build
```

默认地址：

- 插件入口：`http://127.0.0.1:19094`（默认 `HOST_PORT`）
- 健康检查：`http://127.0.0.1:19094/api/health`

端口相关变量：

- `HOST_PORT`：宿主机映射端口
- `CONTAINER_PORT`：容器内部服务端口
- `POSTGRES_HOST_PORT`：宿主机 PostgreSQL 映射端口

## 部署

仓库提供 Docker 远程部署脚本：

```bash
./scripts/deploy-fbif-sidebar-docgen.sh \
  --host 121.40.214.5 \
  --user root \
  --identity-file "/path/to/vibecoding.pem" \
  --app-dir /opt/fbif-sidebar-docgen \
  --host-port 19094 \
  --postgres-host-port 15433
```

脚本会打包当前项目、上传到服务器、复用或生成 `.env`、检查端口冲突、执行 `docker compose up -d --build`，并访问 `/api/health` 做健康检查。

仓库也包含 GitHub Actions 部署工作流。使用前请在仓库 Secrets 中配置 SSH Key、目标主机、部署目录、端口和 `.env` 内容等信息。

## 常用命令

```bash
npm run dev          # 本地开发，启动前端和后端
npm run dev:raw      # 直接并行运行前端和后端
npm run build        # 构建前端
npm run preview      # 预览前端构建结果
npm run start        # 启动后端服务
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
```

## 注意事项

- 不要提交真实飞书应用密钥、OAuth token、会话 cookie 或生产环境 `.env`。
- 模板变量名称建议与多维表格字段名称保持一致，可减少手动绑定。
- 图片变量依赖附件字段中的可访问 URL，生成前请确认附件字段数据完整。
- 生产环境应使用 HTTPS、真实域名和稳定的 OAuth 回调地址。
