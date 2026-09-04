#!/usr/bin/env bash
# Nightly database backup. A backup that fails silently is worse than none, so
# every step is fatal and the exit status is the whole contract.
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.local}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

: "${POSTGRES_USER:?set POSTGRES_USER}"
: "${POSTGRES_DB:=worklog}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/worklog-${STAMP}.dump"

# -Fc is the custom format: compressed, and restorable selectively with
# pg_restore rather than only as one all-or-nothing SQL script.
docker compose --env-file "$ENV_FILE" exec -T postgres \
	pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$DEST"

# An empty file means pg_dump wrote nothing useful even though it exited 0.
if [[ ! -s "$DEST" ]]; then
	rm -f "$DEST"
	echo "backup produced an empty dump" >&2
	exit 1
fi

echo "wrote $DEST ($(du -h "$DEST" | cut -f1))"

if [[ -n "${BACKUP_S3_URL:-}" ]]; then
	aws s3 cp "$DEST" "${BACKUP_S3_URL%/}/$(basename "$DEST")"
	echo "uploaded to ${BACKUP_S3_URL%/}/$(basename "$DEST")"
fi

# Prune only after a successful write, so a failed run never destroys the last
# good copy.
find "$BACKUP_DIR" -name 'worklog-*.dump' -type f -mtime "+${RETENTION_DAYS}" -delete
