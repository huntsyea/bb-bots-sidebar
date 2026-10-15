// Code / Bots sidebar tabs pin BB's thread-list provider preference.
export const SIDEBAR_MODES = ["code", "bots"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];
export const SIDEBAR_MODE_PROVIDERS: Record<SidebarMode, string> = {
  code: "thread-list/thread-list",
  bots: "bots-sidebar/bot-projects",
};

export function modeForProvider(provider: string | null): SidebarMode | null {
  return SIDEBAR_MODES.find((mode) => SIDEBAR_MODE_PROVIDERS[mode] === provider) ?? null;
}
