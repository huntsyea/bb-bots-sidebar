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

Package engines require BB `>=0.46.1` and SDK `>=0.6.49`; the SDK dependency is
pinned to `0.6.49`. Build metadata confirms BB `0.46.1`, SDK `0.6.49`, and plugin
ID `bots-sidebar`.

The installed main checkout and its output remain untouched during preparation.
After Hunter approves, Warden must verify that no bot approval is pending,
fast-forward main to this branch, build in main, then reload bots-sidebar last
under `../docs/agents/warden-reload-protocol.md`. Do not install from the worktree.

## Taking an upstream update

```sh
../sync-forks.sh                 # what upstream has that we don't
git merge vX.Y.Z                 # upstream releases are tags
# resolve conflicts, keeping both upstream's change and ours above
npx tsc --noEmit && npm test     # 37 private-state/server tests failed upstream before the merge too
git push                         # to origin (our fork)
npm run build && bb plugin reload bots-sidebar
```
