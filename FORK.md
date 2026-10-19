# Fork notes

Local fork of [tobi/bb-bots-sidebar](https://github.com/tobi/bb-bots-sidebar).
`main` is our branch, pushed to `origin` ([huntsyea/bb-bots-sidebar](https://github.com/huntsyea/bb-bots-sidebar)).
The `upstream` remote is fetch-only (push is disabled).

- **Base:** upstream `v1.0.0`
- **Installed in BB from:** this directory (`bb plugin install <path>`)

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
fast-forward main to this branch, build in main, then reload bots-sidebar last
under `../docs/agents/warden-reload-protocol.md`. Do not install from the worktree.

## Reload and rollback safety (BBP-15)

BBP-5 remains on hold until Hunter approves the reload through Warden. The script
does not stop BB, deploy code, or build. Its backup command briefly disables and
re-enables only bots-sidebar. Run it with Bash, SQLite 3, Node.js, and the BB CLI
installed. It requires explicit paths and has no live-data default.

Read-only inspection on 2026-10-18 found the live directory at
`/Users/huntsyea/.bb/plugins/bots-sidebar`, containing `data.db` and `state/`.
Recheck the installed source and data location before deployment. Backups contain
private bot state. Keep them outside Git checkouts and do not attach them to tasks.

### Before an approved reload

1. Follow Warden's reload order: model-profiles, cursor-sidebar, then bots-sidebar.
   Check that no bot approval is pending. Record main's commit and confirm that
   main can fast-forward to `sync/BBP-5`. The prepared rollback commit is
   `df530b00eee5a9917307328d8895d15363520698`.
2. Confirm bots-sidebar is enabled, no approval is pending, and no external process
   writes its data. The backup command runs `bb plugin disable bots-sidebar`, takes
   the SQLite backup and `state/` copy, then runs `bb plugin enable bots-sidebar`.
   BB and its database writer keep running. SQLite `.backup` is consistent while
   BB runs; plugin isolation protects the separate state copy. SQLite remains
   authoritative. Create an external backup root, then run from the sync worktree:

   ```sh
   mkdir -p "$HOME/.bb/backups/bots-sidebar"
   bash "scripts/reload-safety.sh" backup \
     "$HOME/.bb/plugins/bots-sidebar" "$HOME/.bb/backups/bots-sidebar"
   ```

   Record the printed timestamped directory. A zero exit status confirms the
   SQLite backup, state copy, and database integrity check. The backup database
   uses DELETE journal mode so it needs no WAL sidecars. The source is opened
   read-only. Cleanup attempts to re-enable the plugin on errors and INT/TERM.
   If re-enable fails, the command fails and prints the manual recovery command.
   SIGKILL or host failure cannot run cleanup; check plugin status after interruption.
   An already-disabled plugin is rejected without changing its status. Failed
   backup directories remain for inspection; do not use them.
3. After approval, fast-forward main, run typecheck/tests, build there, and reload
   under Warden's protocol. Keep the installed source on main. Check running status,
   plugin logs, bot list, private state, and conversation creation. Do not save
   launch presets until the update is stable. Report results to Warden.

### Roll back after a failed reload

First take another backup of the failed version's data with the command above.
Then run `bb plugin disable bots-sidebar` before changing data. Keep only this
plugin disabled until the old code and compatible data are both in place. BB and
its database writer must keep running. Keep the safety script accessible from
the sync worktree. If the plugin cannot enable for backup, resolve that failure
before proceeding; do not bypass backup isolation.
Choose one data recovery method before reverting the code:

- **Keep current bot edits:** run the command below against the disabled plugin's
  database. It removes only top-level `launchPreset` keys, including JSON null,
  in one transaction. It prints the changed-row count; a repeat prints zero.
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

Then restore the recorded code revision in main, rebuild, then run
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
../sync-forks.sh                 # what upstream has that we don't
git merge vX.Y.Z                 # upstream releases are tags
# resolve conflicts, keeping both upstream's change and ours above
npx tsc --noEmit && npm test
git push                         # to origin (our fork)
# Follow the approved reload and rollback procedure above before deployment.
```
