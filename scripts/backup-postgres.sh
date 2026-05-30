#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-fbif-sidebar-docgen}"
POSTGRES_CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-fbif-sidebar-docgen-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-larkdocvar}"
BACKUP_DIR="${POSTGRES_BACKUP_DIR:-./backups/postgres}"
KEEP_DAYS="${POSTGRES_BACKUP_KEEP_DAYS:-14}"

mkdir -p "${BACKUP_DIR}"

STAMP="$(date +%Y%m%d%H%M%S)"
OUT="${BACKUP_DIR}/${APP_NAME}-${POSTGRES_DB}-${STAMP}.dump"
TMP="${OUT}.tmp"

if ! docker inspect "${POSTGRES_CONTAINER_NAME}" >/dev/null 2>&1; then
  echo "[backup] PostgreSQL container not found: ${POSTGRES_CONTAINER_NAME}" >&2
  exit 1
fi

echo "[backup] Dumping ${POSTGRES_DB} from ${POSTGRES_CONTAINER_NAME}"
docker exec -t "${POSTGRES_CONTAINER_NAME}" pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Fc > "${TMP}"

if [[ ! -s "${TMP}" ]]; then
  rm -f "${TMP}"
  echo "[backup] Backup file is empty" >&2
  exit 1
fi

mv "${TMP}" "${OUT}"
chmod 600 "${OUT}"
echo "[backup] Wrote ${OUT}"

if [[ "${KEEP_DAYS}" =~ ^[0-9]+$ && "${KEEP_DAYS}" -gt 0 ]]; then
  find "${BACKUP_DIR}" -type f -name "${APP_NAME}-${POSTGRES_DB}-*.dump" -mtime "+${KEEP_DAYS}" -print -delete
fi
