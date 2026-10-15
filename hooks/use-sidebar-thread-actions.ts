import { useMemo } from "react";
import { experimental_useThreadActions, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

/** bb's own archive: archives the thread and its children, closing panes that show them. */
export const ARCHIVE_THREAD_ACTION = "bb--core/archive";

/** The sidebar thread actions SDK 0.4 provided, rebuilt from SDK 0.6 navigation and API calls. */
export interface SidebarThreadActions {
  /** `split: true` applies bb's split placement rules and falls back to plain navigation. */
  open(threadId: string, options?: { split?: boolean }): void;
  /** `projectId` also becomes the composer's project selection. */
  openNewThread(options?: { projectId?: string; focusPrompt?: boolean }): void;
  setRead(threadId: string, read: boolean): Promise<void>;
  /** Silent rename, for the plugin's own rename dialog. */
  rename(threadId: string, title: string): Promise<void>;
}

export function useSidebarThreadActions(): SidebarThreadActions {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  return useMemo(() => ({
    open: (threadId, options) => navigate.toThread(threadId, options),
    openNewThread: (options) => navigate.toCompose(options),
    setRead: async (threadId, read) => { await (read ? sdk.threads.markRead({ threadId }) : sdk.threads.markUnread({ threadId })); },
    rename: async (threadId, title) => { await sdk.threads.update({ threadId, title }); },
  }), [navigate, sdk]);
}

/** Runs bb's native archive action for one row; null while bb offers none for the thread. */
export function useArchiveThread(thread: PluginSidebarThread): (() => void) | null {
  const { environment } = thread;
  const environmentId = environment?.id ?? null, environmentPath = environment?.path ?? null;
  // A sidebar environment may lack an id; an action target's environment may not.
  const target = useMemo<PluginThreadActionTarget>(() => ({
    ...thread, environment: environmentId ? { id: environmentId, path: environmentPath } : null,
  }), [thread, environmentId, environmentPath]);
  const [entry] = experimental_useThreadActions(target, { keys: [ARCHIVE_THREAD_ACTION] });
  if (!entry || entry.action.disabled) return null;
  return () => { void entry.action.run(); };
}
