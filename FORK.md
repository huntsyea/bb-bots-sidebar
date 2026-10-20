# Fork notes

Local fork of [tobi/bb-bots-sidebar](https://github.com/tobi/bb-bots-sidebar).
`main` is our branch, pushed to `origin` ([huntsyea/bb-bots-sidebar](https://github.com/huntsyea/bb-bots-sidebar)).
The `upstream` remote is fetch-only (push is disabled).

- **Base:** upstream `v1.0.0`
- **Installed in BB from:** this directory (`bb plugin install <path>`)

## Current requirements — 2026-10-20

`package.json` requires BB `>=0.46.1` and Plugin SDK `>=0.6.49`.
The README now gives these same minimum versions; its former BB 0.42
requirement is obsolete. Its Git install example selects upstream. This fork
is installed from `/Users/huntsyea/Dev/bb-plugins/bb-bots-sidebar`.
The BBP-5 merge is now in `main`. The preparation results below are historical.

## Our changes

| Change | Main files |
|---|---|
| Threads / Bots tabs above the sidebar list. They pin BB's `sidebar.threadListProvider`. Threads follows the list chosen in Settings → Appearance. | `components/sidebar-mode-tabs.tsx`, `lib/sidebar-mode.ts`, `sidebar_mode_*` in `server.ts` and `contract.ts` |
| The Bots list shows only bots. The unassigned Chats pane is opt-in ("Show unassigned chats" in the + menu). | `app.tsx` (`SHOW_CHATS_KEY`) |
| Plugin SDK 0.6.49 (needs BB ≥ 0.46.1). Row actions use BB's native context menu and archive action; navigation uses the public SDK. | `app.tsx`, `components/conversation-archive-button.tsx`, tests |
| `bb bots` manages bots: `show`, `create`, `update`, `projects join/leave/own/release`, `sections list/create/rename/delete`, `chat`, plus the existing `list` and `message`. Built with `defineCli`. | `lib/bots-cli.ts` |
| Bot writes (create, update, project roles, sections, visibility, starting conversations) live in one service shared by the sidebar RPCs, the CLI and the bots' own tools. | `lib/bot-service.ts`, `server.ts` |
| "Agents may create bots" setting (Off / Ask / Allow, default Ask) gates `create` and `update` from a BB thread; Ask shows an approval form in that thread. | `bb.settings.define` in `server.ts`, `authorize` in `lib/bots-cli.ts`, `components/bot-change-approval.tsx`, `lib/bot-change-approval.ts` |
| Tests run with `--no-experimental-webstorage`, so Node 26's global `localStorage` does not shadow jsdom's. | `package.json`, `tests/setup.ts` |

Keep the plugin id `bots-sidebar` and the KV key `sidebar:code-provider`. Changing either loses stored state.

## BBP-5 preparation — 2026-10-18

Merged upstream `ab0e490` and `d54ae23` on `sync/BBP-5` in the isolated
`../.worktrees/bb-bots-sidebar-BBP-5` worktree. Rollback point:
`df530b00eee5a9917307328d8895d15363520698`.

The merge keeps our tabs, opt-in Chats, management CLI, shared write service,
and agent approval controls. Launch-preset creation goes through that shared
service. SDK fixtures use upstream's native-action test host; Node 26 webstorage
protection and our test setup remain enabled.

Typecheck and build pass. Tests: 434 pass, 38 fail (472 total), compared with
416 pass, 37 fail in `../docs/agents/test-baseline-2026-10-18.md`. All 37 baseline
failure names remain. The only added failure is:

- `tests/server.test.ts > private bot identities > persists launch presets privately and preserves them through older clients and reloads`

This new upstream test also fails on upstream `d54ae23` alone: `ENOENT` reading
the private `state/<bot-id>/bot.json` export. No baseline failure was removed.
The remaining 18 added tests pass. Live UI validation remains for approved reload.

BBP-14 resolved these failures: the SDK test host used the macOS temp path under
`/var`, a symlink to `/private/var`. Private exports correctly reject symlink
ancestors. The Vitest configuration now uses the real temp root for test workers;
production confinement checks are unchanged. The main baseline passes 453/453
tests; the merged branch passes 472/472, including launch-preset persistence.

Package engines require BB `>=0.46.1` and SDK `>=0.6.49`; the SDK dependency is
pinned to `0.6.49`. Build metadata confirms BB `0.46.1`, SDK `0.6.49`, and plugin
ID `bots-sidebar`.

The installed main checkout and its output remain untouched during preparation.
After Hunter approves, Warden must verify that no bot approval is pending,
use the single-outage reload below for bots-sidebar last
under `../docs/agents/warden-reload-protocol.md`. Do not install from the worktree.

## Reload and rollback safety (BBP-15)

Each future reload requires Hunter's approval through Warden. The script
never stops BB or its database writer. Its reload command disables only
bots-sidebar, backs up data, fast-forwards main, installs dependencies, builds,
and enables the plugin once to load the new output. Its separate backup command
disables and re-enables only bots-sidebar without changing code. Run it with
Bash, SQLite 3, Git, Node.js, and the BB CLI installed; reload also requires npm.
It requires explicit paths and has no live-data default.

Read-only inspection on 2026-10-18 found the live directory at
`/Users/huntsyea/.bb/plugins/bots-sidebar`, containing `data.db` and `state/`.
Recheck the installed source and data location before deployment. Backups contain
private bot state. Keep them outside Git checkouts and do not attach them to tasks.

### Before an approved reload

1. Follow Warden's reload order: model-profiles, cursor-sidebar, then bots-sidebar.
   Check that no bot approval is pending. Record main's commit and confirm that
   main can fast-forward to the reviewed `sync/<KEY>` branch. Record a fresh
   rollback commit; `df530b00eee5a9917307328d8895d15363520698` is the historical
   BBP-5 rollback point.
2. Validate the target ref with typecheck and the full test suite in an isolated
   worktree before the maintenance window. Confirm that the installed source is
   this main checkout, main is clean, bots-sidebar is enabled, no approval is
   pending, and no external process writes its data. Do not run concurrent
   backups, merges, builds, or plugin enable operations. Create an external backup
   root, then run from the installed main checkout after approval:

   ```sh
   mkdir -p "$HOME/.bb/backups/bots-sidebar"
   bash "scripts/reload-safety.sh" reload "sync/<KEY>" \
     "$HOME/.bb/plugins/bots-sidebar" "$HOME/.bb/backups/bots-sidebar"
   ```

   The command runs this sequence in one outage:
   `bb plugin disable bots-sidebar` → SQLite backup and `state/` copy →
   backup integrity check → `git merge --ff-only <ref>` → `npm ci` →
   `npm run build` → `bb plugin enable bots-sidebar`.
   Enable loads the new code; do not run a second reload. BB and its database
   writer keep running. SQLite is authoritative; plugin isolation protects the
   separate state copy.

   Record the timestamped backup path printed before merge. The source database
   is opened read-only. The backup uses DELETE journal mode and needs no WAL
   sidecars. A zero exit status confirms the complete sequence, but does not
   replace the runtime checks below.
3. Verify main is at the intended ref. Check running status with `bb plugin list`,
   plugin logs, the bot list, private state, and conversation creation. Do not
   save launch presets until the update is stable. Report results to Warden.

If backup or merge fails, main stays at its original revision. If install, build,
or enable fails after a successful merge, main stays at the target revision;
dependencies or build output can be incomplete. There is no automatic code or
data rollback. The EXIT trap attempts to enable the plugin on every failure
after isolation starts, including INT/TERM. This can load old or incomplete
output after a failed build: check plugin status and logs, then repair or use
the rollback procedure below. If enable fails, the script exits with an error
and prints the manual recovery command. SIGKILL or host failure cannot run the
trap. An already-disabled plugin is rejected without changing its status.
Failed backup directories remain for inspection; do not use them.

For an approved backup without a deployment, use `backup DATA_DIR BACKUP_ROOT`.
It uses the same backup and cleanup logic and enables the plugin after the
integrity check. This command also causes a plugin outage.

### Roll back after a failed reload

First take another backup of the failed version's data:

```sh
bash "scripts/reload-safety.sh" backup \
  "$HOME/.bb/plugins/bots-sidebar" "$HOME/.bb/backups/bots-sidebar"
```

Then run `bb plugin disable bots-sidebar` before changing data. Keep only this
plugin disabled until the old code and compatible data are both in place. BB and
its database writer must keep running. Keep the safety script accessible from
the sync worktree. If the plugin cannot enable for backup, resolve that failure
before proceeding; do not bypass backup isolation.
Choose one data recovery method before reverting the code:

- **Keep current bot edits:** run the command below against the disabled plugin's
  database. It removes only top-level `launchPreset` keys, including JSON null,
  in one transaction using `json_type(data,'$.launchPreset') IS NOT NULL`.
  It prints the changed-row count; a repeat prints zero.
  Other fields and tables remain intact. This deliberately discards saved launch
  defaults. It does not remove unrelated incompatible fields from future updates.

  ```sh
  bash "scripts/reload-safety.sh" strip-launch-presets \
    "$HOME/.bb/plugins/bots-sidebar/data.db"
  ```

- **Restore pre-update state:** with bots-sidebar disabled, preserve the entire
  current data directory in a separate recovery folder. Use SQLite `.restore` to restore the
  chosen backup's `data.db` into the target database, then replace `state/` with
  the matching backup copy. Do not copy a database over active WAL sidecars or
  combine a database and state directory from different backups. This discards
  bot changes made since the backup. Verify `PRAGMA integrity_check` returns `ok`.

Only after the strip or restore, restore the recorded code revision in main,
run `npm ci` and `npm run build`, then run
`bb plugin enable bots-sidebar`. Verify the bot list, state, logs, and running
status. Report the rollback result to Warden. A code-only rollback to `df530b0`
or earlier is unsafe: the old strict metadataSchema rejects any `launchPreset`
key, including JSON null. Private files are exports; after the strip, the
restored code regenerates them from SQLite when state is prepared.

Validation used copies only: a read-only live backup contained five bots. Adding
a preset in a separate copy made main's unchanged `createBotStore().list()` throw;
stripping it restored exact equality with all five original decoded records.
The committed script test covers WAL backup, state copying, spaces/apostrophes in
paths, null/absent presets, repeat runs, unrelated fields/tables, and an unchanged
source database. No live strip, deployment, or reload was performed.

## Warden corrections — 2026-10-19 (BBP-17)

- Key presence is the compatibility test. Use
  `json_type(data,'$.launchPreset') IS NOT NULL` for every presence check. JSON
  null returns the text `null` from `json_type`, so it counts as present. On the
  read-only live check, Chief had a real preset and Warden had JSON null: two
  incompatible records for the strict schema in `df530b0`, the predecessor of
  `03daa73`, and earlier. Strip removes the top-level key for both values.
- Never suspend the BB server or its database writer for backup or rollback.
  That freezes every thread. The script disables only bots-sidebar around the
  DB/state copy and re-enables it afterward, including error cleanup. Do not run
  concurrent backups, plugin enable operations, or external writes during this
  interval. Disable/re-enable loads installed plugin output; use backup only in
  an approved maintenance window. This correction was tested with CLI stubs and
  temporary databases; the live plugin was not disabled or reloaded.

Read-only preset count (safe while the plugin runs):

```sh
bash "scripts/reload-safety.sh" count-launch-presets \
  "$HOME/.bb/plugins/bots-sidebar/data.db"
```

Tests cover real and null presets separately, source preservation, WAL backup,
plugin isolation during the copy, and cleanup after copy/database/CLI failures.
The implementation uses one cleanup function and the existing SQLite tools;
no runtime code or build output changes are required.

## Taking an upstream update

```sh
bash "/Users/huntsyea/Dev/bb-plugins/sync-forks.sh"
```

The root [sync-forks.sh](/Users/huntsyea/Dev/bb-plugins/sync-forks.sh)
fetches and reports upstream changes; it does not merge or deploy.
Prepare the selected upstream release in an isolated `sync/<KEY>` worktree.
Preserve the fork changes above, record the rollback commit, and validate the
candidate there. Report conflicts, results, and engine/SDK compatibility to Warden.
Follow the [Warden reload protocol](/Users/huntsyea/Dev/bb-plugins/docs/agents/warden-reload-protocol.md)
for approval, fast-forward, deployment order, and runtime checks. Use the
single-outage procedure above for an approved bots-sidebar deployment.
