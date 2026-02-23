#!/usr/bin/env bash
set -euo pipefail

SSH_ALIAS="aliyun-prod"
APP_DIR="/opt/larkdocvar-login"
APP_NAME="larkdocvar-login"
HOST_PORT="18081"
CONTAINER_PORT="3180"
KEEP_RELEASES="5"
APP_ENV_B64=""

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-aliyun-docker.sh [options]

Options:
  --alias <ssh_alias>           SSH alias (default: aliyun-prod)
  --app-dir <remote_path>       Remote deploy root (default: /opt/larkdocvar-login)
  --app-name <container_name>   Container/compose project name (default: larkdocvar-login)
  --host-port <port>            Host exposed port (default: 18081)
  --container-port <port>       Container internal port (default: 3180)
  --keep-releases <num>         Keep latest N releases (default: 5)
  --app-env-b64 <base64>        Optional base64 .env content for remote bootstrap
  -h, --help                    Show this help
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --alias)
      SSH_ALIAS="$2"
      shift 2
      ;;
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --app-name)
      APP_NAME="$2"
      shift 2
      ;;
    --host-port)
      HOST_PORT="$2"
      shift 2
      ;;
    --container-port)
      CONTAINER_PORT="$2"
      shift 2
      ;;
    --keep-releases)
      KEEP_RELEASES="$2"
      shift 2
      ;;
    --app-env-b64)
      APP_ENV_B64="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deploy] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STAMP="$(date +%Y%m%d%H%M%S)"
SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
RELEASE_NAME="${SHORT_SHA:-manual}-${STAMP}"
RELEASE_TAR="/tmp/larkdocvar-release-${RELEASE_NAME}.tgz"
REMOTE_RELEASE_TAR="/tmp/larkdocvar-release.tgz"

echo "[deploy] Packaging release archive: $RELEASE_TAR"
tar -czf "$RELEASE_TAR" \
  --exclude=".git" \
  --exclude=".github" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude="stitch-downloads" \
  --exclude=".DS_Store" \
  .

echo "[deploy] Uploading package to server alias: $SSH_ALIAS"
scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$RELEASE_TAR" "$SSH_ALIAS:$REMOTE_RELEASE_TAR"

REMOTE_ENV="$(printf \
  "APP_DIR=%q APP_NAME=%q HOST_PORT=%q CONTAINER_PORT=%q KEEP_RELEASES=%q APP_ENV_B64=%q RELEASE_FILE=%q RELEASE_NAME=%q" \
  "$APP_DIR" "$APP_NAME" "$HOST_PORT" "$CONTAINER_PORT" "$KEEP_RELEASES" "$APP_ENV_B64" "$REMOTE_RELEASE_TAR" "$RELEASE_NAME")"

echo "[deploy] Running remote deploy script"
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_ALIAS" \
  "${REMOTE_ENV} bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

command -v docker >/dev/null 2>&1 || { echo "Docker 未安装"; exit 1; }

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "docker-compose 或 docker compose 不可用"
  exit 1
fi

mkdir -p "${APP_DIR}/releases"
RELEASE_DIR="${APP_DIR}/releases/${RELEASE_NAME}"
CURRENT_LINK="${APP_DIR}/current"

rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
tar -xzf "${RELEASE_FILE}" -C "${RELEASE_DIR}"

if [[ -f "${CURRENT_LINK}/.env" && ! -f "${RELEASE_DIR}/.env" ]]; then
  cp "${CURRENT_LINK}/.env" "${RELEASE_DIR}/.env"
fi

if [[ ! -f "${RELEASE_DIR}/.env" && -n "${APP_ENV_B64:-}" ]]; then
  printf '%s' "${APP_ENV_B64}" | tr -d '\r\n ' | base64 -d > "${RELEASE_DIR}/.env"
fi

if [[ ! -f "${RELEASE_DIR}/.env" ]]; then
  touch "${RELEASE_DIR}/.env"
fi

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${RELEASE_DIR}/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${RELEASE_DIR}/.env"
  else
    echo "${key}=${value}" >> "${RELEASE_DIR}/.env"
  fi
}

upsert_env "HOST_PORT" "${HOST_PORT}"
upsert_env "CONTAINER_PORT" "${CONTAINER_PORT}"
upsert_env "PORT" "${CONTAINER_PORT}"
upsert_env "HOST" "0.0.0.0"

if ss -ltn "( sport = :${HOST_PORT} )" | grep -q LISTEN; then
  if docker ps --filter "name=^/${APP_NAME}$" --format '{{.Ports}}' | grep -q ":${HOST_PORT}->"; then
    echo "[remote] HOST_PORT=${HOST_PORT} currently used by ${APP_NAME}, continue rolling update"
  else
    echo "[remote] 端口冲突: HOST_PORT=${HOST_PORT} 已被占用"
    ss -ltnp | awk -v p=":${HOST_PORT}" '$4 ~ p"$" {print}'
    exit 1
  fi
fi

ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
cd "${CURRENT_LINK}"
docker rm -f "${APP_NAME}" >/dev/null 2>&1 || true
${DC} -p "${APP_NAME}" up -d --build --remove-orphans

HEALTH_OK="0"
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null; then
    HEALTH_OK="1"
    break
  fi
  sleep 1
done

if [[ "${HEALTH_OK}" != "1" ]]; then
  echo "[remote] 健康检查失败: http://127.0.0.1:${HOST_PORT}/api/health"
  docker logs --tail 80 "${APP_NAME}" || true
  exit 1
fi

PRUNE_FROM=$((KEEP_RELEASES + 1))
ls -1dt "${APP_DIR}/releases"/* 2>/dev/null | tail -n +"${PRUNE_FROM}" | xargs -r rm -rf

echo "[remote] DEPLOY_OK"
echo "[remote] APP_DIR=${APP_DIR}"
echo "[remote] HOST_PORT=${HOST_PORT}"
REMOTE_SCRIPT

rm -f "$RELEASE_TAR"
echo "[deploy] Done. Health check endpoint: http://127.0.0.1:${HOST_PORT}/api/health"
