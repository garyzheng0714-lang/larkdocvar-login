#!/usr/bin/env bash
# 把仓库内 docs/docx-api-integration.md 同步到线上飞书云文档（Docx API 文档红线固化）。
#
# 背景：CLAUDE.md / docx-api-integration.md 规定——本地 Markdown 是 API 文档的唯一真源，
# 每次更新后必须用飞书开放平台 API（而非 Web UI 手工编辑）同步到线上云文档。本脚本把这条
# 流程固化为一条可重复命令，避免再出现"本地改了、线上忘了同步、却标成已同步"的漂移。
#
# 用法：
#   bash scripts/sync-docx-api-doc.sh --dry-run   # 预览将下发的请求，不写线上
#   bash scripts/sync-docx-api-doc.sh --yes       # 实际覆盖线上文档正文
#   （不带参数 = 拒绝执行并提示，避免误触发写操作）
#
# 前置：lark-cli 已登录、且 user 身份具备 docx 写权限
#   lark-cli auth login --scope "docx:document"
#
# 注意：overwrite 会清空线上文档正文后按 Markdown 重建。该文档当前不含图片/画板/嵌入表格，
# 重建安全；但会清除文档内的评论（API 参考文档以仓库为准，可接受）。如需保留评论，请改用
# lark-cli docs +update 的 str_replace / block_replace 做局部精修，而不是整篇 overwrite。
set -euo pipefail

DOC_URL="https://foodtalks.feishu.cn/docx/GMc4diq86oTS9SxQ8txcDPYenZ2"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# lark-cli 的 --content @file 只接受当前目录下的相对路径，故先切到仓库根再用相对路径。
REL_MD="docs/docx-api-integration.md"
cd "$REPO_ROOT"

if [[ ! -f "$REL_MD" ]]; then
  echo "找不到 API 文档：$REPO_ROOT/$REL_MD" >&2
  exit 1
fi

MODE="${1:-}"
case "$MODE" in
  --dry-run)
    echo "[dry-run] 将用 $REL_MD 覆盖：$DOC_URL"
    exec lark-cli docs +update --api-version v2 \
      --doc "$DOC_URL" --command overwrite --doc-format markdown \
      --content @"$REL_MD" --dry-run
    ;;
  --yes)
    echo "用 $REL_MD 覆盖线上飞书云文档正文：$DOC_URL"
    exec lark-cli docs +update --api-version v2 \
      --doc "$DOC_URL" --command overwrite --doc-format markdown \
      --content @"$REL_MD"
    ;;
  *)
    echo "这是覆盖线上飞书云文档的写操作。" >&2
    echo "  预览：bash scripts/sync-docx-api-doc.sh --dry-run" >&2
    echo "  执行：bash scripts/sync-docx-api-doc.sh --yes" >&2
    exit 2
    ;;
esac
