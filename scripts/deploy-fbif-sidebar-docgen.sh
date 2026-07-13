#!/usr/bin/env bash
set -euo pipefail

SSH_ALIAS=""
SSH_HOST="121.40.214.5"
SSH_USER="root"
SSH_IDENTITY_FILE=""
APP_DIR="/opt/fbif-sidebar-docgen"
APP_NAME="fbif-sidebar-docgen"
HOST_PORT="19094"
CONTAINER_PORT="3180"
POSTGRES_HOST_PORT="15433"
POSTGRES_CONTAINER_NAME="fbif-sidebar-docgen-postgres"
KEEP_RELEASES="5"
APP_ENV_B64=""

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-fbif-sidebar-docgen.sh [options]

Options:
  --alias <ssh_alias>           SSH alias (optional)
  --host <host>                 SSH host (default: 121.40.214.5)
  --user <user>                 SSH user (default: root)
  --identity-file <path>        SSH private key path
  --app-dir <remote_path>       Remote deploy root (default: /opt/fbif-sidebar-docgen)
  --app-name <container_name>   Container/compose project name (default: fbif-sidebar-docgen)
  --host-port <port>            Host exposed port (default: 19094)
  --container-port <port>       Container internal port (default: 3180)
  --postgres-host-port <port>   Host mapped PostgreSQL port (default: 15433)
  --postgres-container <name>   PostgreSQL container name (default: fbif-sidebar-docgen-postgres)
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
    --host)
      SSH_HOST="$2"
      shift 2
      ;;
    --user)
      SSH_USER="$2"
      shift 2
      ;;
    --identity-file)
      SSH_IDENTITY_FILE="$2"
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
    --postgres-host-port)
      POSTGRES_HOST_PORT="$2"
      shift 2
      ;;
    --postgres-container)
      POSTGRES_CONTAINER_NAME="$2"
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
RELEASE_TAR="/tmp/fbif-sidebar-docgen-release-${RELEASE_NAME}.tgz"
REMOTE_RELEASE_TAR="/tmp/fbif-sidebar-docgen-release.tgz"
SSH_TARGET="${SSH_ALIAS:-${SSH_USER}@${SSH_HOST}}"
SSH_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "${SSH_IDENTITY_FILE}" ]]; then
  SSH_ARGS+=(-i "${SSH_IDENTITY_FILE}")
fi

echo "[deploy] Packaging release archive: $RELEASE_TAR"
tar -czf "$RELEASE_TAR" \
  --exclude=".git" \
  --exclude=".github" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude="stitch-downloads" \
  --exclude=".DS_Store" \
  .

echo "[deploy] Uploading package to server: $SSH_TARGET"
scp "${SSH_ARGS[@]}" "$RELEASE_TAR" "$SSH_TARGET:$REMOTE_RELEASE_TAR"

REMOTE_ENV="$(printf \
  "APP_DIR=%q APP_NAME=%q HOST_PORT=%q CONTAINER_PORT=%q POSTGRES_HOST_PORT=%q POSTGRES_CONTAINER_NAME=%q KEEP_RELEASES=%q APP_ENV_B64=%q RELEASE_FILE=%q RELEASE_NAME=%q" \
  "$APP_DIR" "$APP_NAME" "$HOST_PORT" "$CONTAINER_PORT" "$POSTGRES_HOST_PORT" "$POSTGRES_CONTAINER_NAME" "$KEEP_RELEASES" "$APP_ENV_B64" "$REMOTE_RELEASE_TAR" "$RELEASE_NAME")"

echo "[deploy] Running remote deploy script"
ssh "${SSH_ARGS[@]}" "$SSH_TARGET" \
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

read_env_value() {
  local key="$1"
  if [[ ! -f "${RELEASE_DIR}/.env" ]]; then
    return 0
  fi
  grep -E "^${key}=" "${RELEASE_DIR}/.env" | tail -n 1 | cut -d= -f2-
}

is_unstable_postgres_data_dir() {
  local value="$1"
  [[ "${value}" == "${APP_DIR}/current/"* || "${value}" == "${APP_DIR}/releases/"* ]]
}

copy_postgres_data_if_needed() {
  local source_dir="$1"
  local target_dir="$2"
  if [[ -n "${source_dir}" && -f "${source_dir}/PG_VERSION" && ! -f "${target_dir}/PG_VERSION" ]]; then
    echo "[remote] Migrating PostgreSQL data directory to ${target_dir}" >&2
    mkdir -p "${target_dir}"
    docker stop "${POSTGRES_CONTAINER_NAME}" >/dev/null 2>&1 || true
    cp -a "${source_dir}/." "${target_dir}/"
  fi
}

resolve_postgres_data_dir() {
  local configured
  configured="$(read_env_value "POSTGRES_DATA_DIR")"
  local stable_dir="${APP_DIR}/data/postgres"
  local existing_source=""
  existing_source="$(docker inspect "${POSTGRES_CONTAINER_NAME}" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"

  if [[ -n "${configured}" ]]; then
    if is_unstable_postgres_data_dir "${configured}"; then
      copy_postgres_data_if_needed "${existing_source}" "${stable_dir}"
      copy_postgres_data_if_needed "${configured}" "${stable_dir}"
      printf '%s' "${stable_dir}"
      return 0
    fi
    printf '%s' "${configured}"
    return 0
  fi

  if [[ -n "${existing_source}" ]] && ! is_unstable_postgres_data_dir "${existing_source}"; then
    printf '%s' "${existing_source}"
    return 0
  fi

  copy_postgres_data_if_needed "${existing_source}" "${stable_dir}"

  printf '%s' "${stable_dir}"
}

upsert_env "HOST_PORT" "${HOST_PORT}"
upsert_env "CONTAINER_PORT" "${CONTAINER_PORT}"
upsert_env "APP_NAME" "${APP_NAME}"
upsert_env "POSTGRES_HOST_PORT" "${POSTGRES_HOST_PORT}"
upsert_env "POSTGRES_CONTAINER_NAME" "${POSTGRES_CONTAINER_NAME}"
upsert_env "PORT" "${CONTAINER_PORT}"
upsert_env "HOST" "0.0.0.0"
POSTGRES_DATA_DIR_VALUE="$(resolve_postgres_data_dir)"
mkdir -p "${POSTGRES_DATA_DIR_VALUE}"
upsert_env "POSTGRES_DATA_DIR" "${POSTGRES_DATA_DIR_VALUE}"
echo "[remote] POSTGRES_DATA_DIR=${POSTGRES_DATA_DIR_VALUE}"

if ss -ltn "( sport = :${HOST_PORT} )" | grep -q LISTEN; then
  if docker ps --filter "name=^/${APP_NAME}$" --format '{{.Ports}}' | grep -q ":${HOST_PORT}->"; then
    echo "[remote] HOST_PORT=${HOST_PORT} currently used by ${APP_NAME}, continue rolling update"
  else
    echo "[remote] 端口冲突: HOST_PORT=${HOST_PORT} 已被占用"
    ss -ltnp | awk -v p=":${HOST_PORT}" '$4 ~ p"$" {print}'
    exit 1
  fi
fi

if ss -ltn "( sport = :${POSTGRES_HOST_PORT} )" | grep -q LISTEN; then
  if docker ps --filter "name=^/${POSTGRES_CONTAINER_NAME}$" --format '{{.Ports}}' | grep -q ":${POSTGRES_HOST_PORT}->"; then
    echo "[remote] POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT} currently used by ${POSTGRES_CONTAINER_NAME}, continue rolling update"
  else
    echo "[remote] 端口冲突: POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT} 已被占用"
    ss -ltnp | awk -v p=":${POSTGRES_HOST_PORT}" '$4 ~ p"$" {print}'
    exit 1
  fi
fi

ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
cd "${CURRENT_LINK}"

# 先建后切：先构建新镜像，此时旧容器仍在服务、零停机；构建失败直接退出、旧容器毫发无损。
# （旧流程是 docker rm -f 先杀旧容器、再 up --build 边构建边停机数分钟，失败还无回滚——已废弃。）
echo "[remote] 构建新镜像（旧容器继续服务中）…"
if ! ${DC} -p "${APP_NAME}" build; then
  echo "[remote] 镜像构建失败，旧容器未受影响，部署中止"
  exit 1
fi

# 记录当前在跑的镜像（tag + id），用于健康检查失败时回滚；首次部署为空则跳过回滚。
ROLLBACK_IMAGE_TAG="$(docker inspect --format '{{.Config.Image}}' "${APP_NAME}" 2>/dev/null || true)"
ROLLBACK_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${APP_NAME}" 2>/dev/null || true)"

# 切换：用已构建好的镜像重建容器（不带 --build）。停机仅为一次秒级容器重建，而非整段构建时间。
${DC} -p "${APP_NAME}" up -d --remove-orphans

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
  # 自动回滚到上一个可用镜像，避免部署失败让服务长时间下线。
  if [[ -n "${ROLLBACK_IMAGE_ID}" && -n "${ROLLBACK_IMAGE_TAG}" ]]; then
    echo "[remote] 回滚到上一个可用镜像 ${ROLLBACK_IMAGE_TAG} …"
    docker tag "${ROLLBACK_IMAGE_ID}" "${ROLLBACK_IMAGE_TAG}" || true
    ${DC} -p "${APP_NAME}" up -d --remove-orphans || true
    if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
      echo "[remote] 已回滚到上一个可用版本（本次部署失败，服务已恢复）"
    else
      echo "[remote] 回滚后健康检查仍未通过，请人工介入"
    fi
  else
    echo "[remote] 无可回滚镜像（可能是首次部署）"
  fi
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
