#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  fail "Usage: bash scripts/reload-safety.sh backup DATA_DIR BACKUP_ROOT | strip-launch-presets DATA_DB"
}
[[ $# -ge 1 ]] || usage
command -v sqlite3 >/dev/null || fail "sqlite3 is required"

case "$1" in
  backup)
    [[ $# -eq 3 ]] || usage
    source_dir=$(cd "$2" && pwd -P)
    [[ -f "$source_dir/data.db" && -d "$source_dir/state" ]] || fail "Expected data.db and state/ in DATA_DIR"
    # Require an existing external root so a typo cannot create repo content.
    backup_root=$(cd "$3" && pwd -P)
    if git -C "$backup_root" rev-parse --show-toplevel >/dev/null 2>&1; then
      fail "BACKUP_ROOT must be outside a Git checkout"
    fi
    repo=$(cd "$(dirname "$0")/.." && pwd -P)
    case "$backup_root/" in "$repo/"*) fail "BACKUP_ROOT must be outside the repository";; esac
    case "$backup_root/" in "$source_dir/"*) fail "BACKUP_ROOT must be outside DATA_DIR";; esac
    destination=$(mktemp -d "$backup_root/bots-sidebar-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
    # A fixed relative backup name avoids SQLite shell path quoting rules.
    (cd "$destination" && sqlite3 -readonly "$source_dir/data.db" ".timeout 5000" '.backup data.db')
    cp -R "$source_dir/state" "$destination/state"
    # Make the backup standalone even when the source uses WAL sidecars.
    sqlite3 "$destination/data.db" 'PRAGMA journal_mode=DELETE;' >/dev/null
    [[ $(sqlite3 -readonly "$destination/data.db" 'PRAGMA integrity_check;') == ok ]] || fail "Backup integrity check failed: $destination"
    printf '%s\n' "$destination"
    ;;
  strip-launch-presets)
    [[ $# -eq 2 ]] || usage
    db_dir=$(cd "$(dirname "$2")" && pwd -P)
    database="$db_dir/$(basename "$2")"
    [[ -f "$database" && ! -L "$database" ]] || fail "DATA_DB must be an existing regular database file"
    # Call only with writers stopped. A transaction makes the strip all-or-nothing.
    sqlite3 "$database" ".timeout 5000" "BEGIN IMMEDIATE;
UPDATE bots SET data = json_remove(data, '$.launchPreset')
WHERE json_type(data, '$.launchPreset') IS NOT NULL;
SELECT changes();
COMMIT;"
    ;;
  *) usage;;
esac
