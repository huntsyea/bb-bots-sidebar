import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Threads / Bots sidebar tabs pin BB's thread-list provider preference. Bots is
// this plugin's list; Threads is whichever other list the user chose in
// Settings → Appearance → Sidebar, remembered so the tab can switch back to it.
export const SIDEBAR_MODES = ["threads", "bots"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];
export const BOTS_PROVIDER = "bots-sidebar/bot-projects";
export const DEFAULT_THREADS_PROVIDER = "thread-list/thread-list";
/** BB's "first installed list" choice; it can resolve to either tab. */
export const AUTOMATIC_PROVIDER = "__automatic__";

const THREAD_LIST_PROVIDER = "sidebar.threadListProvider" as const;
// Key predates the Code → Threads rename; kept so the remembered list survives.
const THREADS_PROVIDER_KEY = "sidebar:code-provider";

export function modeForProvider(provider: string | null): SidebarMode | null {
  if (provider === null || provider === AUTOMATIC_PROVIDER) return null;
  return provider === BOTS_PROVIDER ? "bots" : "threads";
}

/**
 * Server side of the tabs. Every read remembers the active list as the Threads
 * tab's whenever it is not ours, so a choice made in Settings → Appearance
 * sticks. Writes are revision-checked against that read, so a preference
 * changed in between fails instead of being overwritten.
 */
export function createSidebarMode(bb: BbPluginApi) {
  async function read() {
    const entry = (await bb.sdk.system.uiPreferences.list()).preferences[THREAD_LIST_PROVIDER];
    const stored = (await bb.storage.kv.get<string>(THREADS_PROVIDER_KEY)) ?? null;
    const threadsProvider = modeForProvider(entry.value) === "threads" ? entry.value : stored;
    if (threadsProvider !== stored && threadsProvider !== null) await bb.storage.kv.set(THREADS_PROVIDER_KEY, threadsProvider);
    return { ...entry, threadsProvider };
  }
  return {
    async get(): Promise<{ provider: string }> {
      return { provider: (await read()).value };
    },
    async set(mode: SidebarMode): Promise<{ provider: string }> {
      const { revision, threadsProvider } = await read();
      const value = mode === "bots" ? BOTS_PROVIDER : threadsProvider ?? DEFAULT_THREADS_PROVIDER;
      const result = await bb.sdk.system.uiPreferences.set({ key: THREAD_LIST_PROVIDER, value, expectedRevision: revision });
      return { provider: result.value };
    },
  };
}
