// Code / Bots sidebar tabs pin BB's thread-list provider preference. Bots is
// this plugin's list; Code is whichever other list the user chose in
// Settings → Appearance → Sidebar, remembered so the tab can switch back to it.
export const SIDEBAR_MODES = ["code", "bots"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];
export const BOTS_PROVIDER = "bots-sidebar/bot-projects";
export const DEFAULT_CODE_PROVIDER = "thread-list/thread-list";
/** BB's "first installed list" choice; it can resolve to either tab. */
export const AUTOMATIC_PROVIDER = "__automatic__";

export function modeForProvider(provider: string | null): SidebarMode | null {
  if (provider === null || provider === AUTOMATIC_PROVIDER) return null;
  return provider === BOTS_PROVIDER ? "bots" : "code";
}

/** The Code provider to remember after seeing `current` active. */
export function rememberedCodeProvider(stored: string | null, current: string): string | null {
  return modeForProvider(current) === "code" ? current : stored;
}

export function providerForMode(mode: SidebarMode, storedCodeProvider: string | null): string {
  return mode === "bots" ? BOTS_PROVIDER : storedCodeProvider ?? DEFAULT_CODE_PROVIDER;
}
