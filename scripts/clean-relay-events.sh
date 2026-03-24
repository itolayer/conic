#!/bin/sh

set -eu

RETENTION_ARG="${1:-30}"
CONTAINER_NAME="${CONIC_NOSTR_RELAY_CONTAINER:-conic-nostr-relay}"
DB_PATH="${CONIC_NOSTR_RELAY_DB_PATH:-/usr/src/app/db/nostr.db}"

if [ "$RETENTION_ARG" = "all" ]; then
  DELETE_SQL="
    PRAGMA foreign_keys = ON;
    SELECT 'eligible_before_delete=' || COUNT(*) FROM event;
    DELETE FROM event;
    SELECT 'deleted=' || changes();
  "
  DESCRIPTION="all stored relay events"
else
  case "$RETENTION_ARG" in
    ''|*[!0-9]*)
      echo "Retention must be a non-negative integer or 'all'" >&2
      exit 1
      ;;
  esac

  DELETE_SQL="
    PRAGMA foreign_keys = ON;
    SELECT 'eligible_before_delete=' || COUNT(*)
      FROM event
      WHERE first_seen < CAST(strftime('%s', date('now', '-${RETENTION_ARG} day')) AS INT);
    DELETE FROM event
      WHERE first_seen < CAST(strftime('%s', date('now', '-${RETENTION_ARG} day')) AS INT);
    SELECT 'deleted=' || changes();
  "
  DESCRIPTION="relay events older than ${RETENTION_ARG} day(s)"
fi

echo "Cleaning ${DESCRIPTION} from ${CONTAINER_NAME}:${DB_PATH}"

docker exec "$CONTAINER_NAME" sh -lc "
  sqlite3 '$DB_PATH' \"$DELETE_SQL\"
"
