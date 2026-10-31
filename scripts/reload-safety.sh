#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  fail "Usage: bash scripts/reload-safety.sh backup DATA_DIR BACKUP_ROOT | reload REF DATA_DIR BACKUP_ROOT | count-launch-presets DATA_DB | strip-launch-presets DATA_DB | rollback-presets TARGET_REF DATA_DB [--dry-run]"
}
[[ $# -ge 1 ]] || usage
command -v sqlite3 >/dev/null || fail "sqlite3 is required"

case "$1" in
  backup|reload)
    operation=$1
    if [[ $operation == reload ]]; then
      [[ $# -eq 4 && -n $2 && $2 != -* ]] || usage
      ref=$2
      shift
    fi
    [[ $# -eq 3 ]] || usage
    source_dir=$(cd "$2" && pwd -P)
    [[ -f "$source_dir/data.db" && -d "$source_dir/state" ]] || fail "Expected data.db and state/ in DATA_DIR"
    # Require an existing external root so a typo cannot create repo content.
    backup_root=$(cd "$3" && pwd -P)
    if git -C "$backup_root" rev-parse --show-toplevel >/dev/null 2>&1; then
      fail "BACKUP_ROOT must be outside a Git checkout"
    fi
    repo=$(cd "$(dirname "$0")/.." && pwd -P)
    if [[ $operation == reload ]]; then
      command -v npm >/dev/null || fail "npm is required for reload"
      [[ $(git -C "$repo" branch --show-current) == main ]] || fail "Reload requires main"
      [[ -z $(git -C "$repo" status --porcelain) ]] || fail "Reload requires a clean checkout"
    fi
    case "$backup_root/" in "$repo/"*) fail "BACKUP_ROOT must be outside the repository";; esac
    case "$backup_root/" in "$source_dir/"*) fail "BACKUP_ROOT must be outside DATA_DIR";; esac
    command -v bb >/dev/null || fail "bb is required for plugin-only backup isolation"
    command -v node >/dev/null || fail "node is required to check plugin status"
    # Do not enable a plugin that was already disabled before this operation.
    bb plugin list --json | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const plugin = JSON.parse(input).plugins.find(p => p.id === "bots-sidebar");
        process.exit(plugin?.enabled === true ? 0 : 1);
      });
    ' || fail "bots-sidebar must be enabled before backup"
    destination=$(mktemp -d "$backup_root/bots-sidebar-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
    backup_complete=false
    resume_plugin() {
      local status=$?
      trap - EXIT
      # Never leave a partial backup that could be mistaken for a recovery point.
      if [[ $backup_complete != true ]]; then
        rm -rf -- "$destination"
        printf '%s\n' "Backup failed; removed incomplete $destination. Nothing was merged." >&2
      fi
      if ! bb plugin enable bots-sidebar >&2; then
        printf '%s\n' "Could not re-enable bots-sidebar; run: bb plugin enable bots-sidebar" >&2
        status=1
      fi
      exit "$status"
    }
    # Unload only this plugin. Never suspend the BB server or its DB writer.
    # Arm cleanup first in case disable fails after unloading the plugin.
    trap resume_plugin EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    bb plugin disable bots-sidebar >&2
    # Open the source read-write: closing the plugin's last connection deletes
    # data.db-wal and data.db-shm, and SQLite cannot open a WAL database without
    # them in read-only mode. The plugin is disabled, so nothing else writes.
    # A fixed relative backup name avoids SQLite shell path quoting rules.
    (cd "$destination" && sqlite3 "$source_dir/data.db" ".timeout 5000" '.backup data.db') || fail "SQLite backup of $source_dir/data.db failed"
    # The copy inherits WAL mode; make it standalone before any read-only open.
    [[ $(sqlite3 "$destination/data.db" 'PRAGMA journal_mode=DELETE;') == delete ]] || fail "Could not set journal_mode=DELETE on the backup"
    [[ $(sqlite3 -readonly "$destination/data.db" 'PRAGMA integrity_check;') == ok ]] || fail "Backup integrity check failed"
    cp -R "$source_dir/state" "$destination/state" || fail "Copying state/ failed"
    backup_complete=true
    if [[ $operation == reload ]]; then
      printf 'Backup: %s\n' "$destination" >&2
      git -C "$repo" merge --ff-only "$ref" >&2
      (cd "$repo" && npm ci && npm run build) >&2
    fi
    bb plugin enable bots-sidebar >&2
    trap - EXIT INT TERM
    printf '%s\n' "$destination"
    ;;
  count-launch-presets)
    [[ $# -eq 2 ]] || usage
    sqlite3 -readonly "$2" "SELECT count(*) FROM bots WHERE json_type(data,'$.launchPreset') IS NOT NULL;"
    ;;
  strip-launch-presets)
    [[ $# -eq 2 ]] || usage
    db_dir=$(cd "$(dirname "$2")" && pwd -P)
    database="$db_dir/$(basename "$2")"
    [[ -f "$database" && ! -L "$database" ]] || fail "DATA_DB must be an existing regular database file"
    # Call only with bots-sidebar disabled. A transaction makes the strip all-or-nothing.
    sqlite3 "$database" ".timeout 5000" "BEGIN IMMEDIATE;
UPDATE bots SET data = json_remove(data, '$.launchPreset')
WHERE json_type(data,'$.launchPreset') IS NOT NULL;
SELECT changes();
COMMIT;"
    ;;
  rollback-presets)
    # Before restoring TARGET_REF's code, strip only the launch presets that the
    # target cannot read (ADR-0004). 03daa73 is the first build that reads them.
    [[ $# -eq 3 || ( $# -eq 4 && $4 == --dry-run ) ]] || usage
    dry_run=false; [[ ${4:-} == --dry-run ]] && dry_run=true
    db_dir=$(cd "$(dirname "$3")" && pwd -P)
    database="$db_dir/$(basename "$3")"
    [[ -f "$database" && ! -L "$database" ]] || fail "DATA_DB must be an existing regular database file"
    repo=$(cd "$(dirname "$0")/.." && pwd -P)
    command -v node >/dev/null || fail "node is required for the schema probe"
    target=$(git -C "$repo" rev-parse --verify --quiet "$2^{commit}") || fail "Unknown rollback target: $2. Nothing was changed."
    first_reader=$(git -C "$repo" rev-parse --verify --quiet "03daa73^{commit}") || fail "03daa73 is missing from $repo; fetch it first. Nothing was changed."
    short=$(git -C "$repo" rev-parse --short "$target")
    plural() { [[ $1 == 1 ]] && printf '%s launch preset' "$1" || printf '%s launch presets' "$1"; }
    # Read-write open: with the plugin disabled, SQLite has removed the WAL
    # sidecars and a read-only open would fail. Reads change nothing.
    count=$(sqlite3 "$database" ".timeout 5000" "SELECT count(*) FROM bots WHERE json_type(data,'$.launchPreset') IS NOT NULL;")
    if [[ $count == 0 ]]; then
      printf '%s\n' "No launch presets stored; nothing to strip for target $short."
      exit 0
    fi
    if ! git -C "$repo" merge-base --is-ancestor "$first_reader" "$target"; then
      reason="Target $short predates launch presets: 03daa73 is not an ancestor, so it rejects every launchPreset key."
      ids=all
      strip_count=$count
    else
      probe=$(mktemp -d "${TMPDIR:-/tmp}/bots-sidebar-probe-XXXXXX")
      trap 'rm -rf -- "$probe"' EXIT
      # Bundle the target's own contract.ts and parse the stored rows with its metadataSchema.
      git -C "$repo" archive "$target" | tar -x -C "$probe" || fail "Could not probe $short: git archive failed. Nothing was changed."
      ln -s "$repo/node_modules" "$probe/node_modules"
      "$repo/node_modules/.bin/rolldown" "$probe/contract.ts" --platform node --format esm --file "$probe/probe.mjs" --external zod,@get-bb/plugin-sdk >/dev/null 2>&1 \
        || fail "Could not probe $short: its contract.ts did not bundle. Nothing was changed; decide by hand (ADR-0004)."
      sqlite3 -json "$database" ".timeout 5000" "SELECT id, data FROM bots WHERE json_type(data,'$.launchPreset') IS NOT NULL;" > "$probe/rows.json"
      verdict=$(node --input-type=module -e '
        import { readFileSync } from "node:fs";
        import { pathToFileURL } from "node:url";
        const [bundle, rowsFile] = process.argv.slice(1);
        const { metadataSchema } = await import(pathToFileURL(bundle).href);
        if (typeof metadataSchema?.safeParse !== "function") process.exit(3);
        const rows = JSON.parse(readFileSync(rowsFile, "utf8") || "[]");
        const rejected = [];
        let other = 0;
        for (const row of rows) {
          const result = metadataSchema.safeParse(JSON.parse(row.data));
          if (result.success) continue;
          const preset = result.error.issues.some((issue) => issue.path?.[0] === "launchPreset" || (issue.code === "unrecognized_keys" && issue.keys?.includes("launchPreset")));
          if (preset) rejected.push(row.id); else other++;
        }
        // IDs go into SQL unquoted-safe only if they look like bot IDs; otherwise stop.
        if (rejected.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))) process.exit(4);
        console.log(JSON.stringify({ rejected, other }));
      ' "$probe/probe.mjs" "$probe/rows.json") || fail "Could not probe $short: its metadataSchema did not load. Nothing was changed; decide by hand (ADR-0004)."
      ids=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).rejected))' "$verdict")
      other=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).other))' "$verdict")
      strip_count=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$ids")
      if [[ $other != 0 ]]; then
        printf '%s\n' "Note: target $short's schema also rejects fields other than launchPreset in $other bot(s); assess those separately (ADR-0004)."
      fi
      if [[ $strip_count == 0 ]]; then
        printf '%s\n' "Target $short reads launch presets: 03daa73 is an ancestor and its schema accepts launchPreset in all $count stored bot(s). Left $(plural "$count") untouched."
        exit 0
      fi
      reason="Target $short descends from 03daa73 (03daa73 is an ancestor), but its schema rejects launchPreset in $strip_count of $count bot(s)."
    fi
    printf '%s\n' "$reason"
    if [[ $dry_run == true ]]; then
      printf '%s\n' "Would strip $(plural "$strip_count"). Nothing was changed (--dry-run)."
      exit 0
    fi
    if [[ $ids == all ]]; then
      where="json_type(data,'$.launchPreset') IS NOT NULL"
    else
      where="json_type(data,'$.launchPreset') IS NOT NULL AND id IN (SELECT value FROM json_each('$ids'))"
    fi
    # Call only with bots-sidebar disabled. A transaction makes the strip all-or-nothing.
    changed=$(sqlite3 "$database" ".timeout 5000" "BEGIN IMMEDIATE;
UPDATE bots SET data = json_remove(data, '$.launchPreset') WHERE $where;
SELECT changes();
COMMIT;")
    printf '%s\n' "Stripped $(plural "$changed")."
    ;;
  *) usage;;
esac
