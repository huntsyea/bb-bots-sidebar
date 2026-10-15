import type { NewThreadRequest, PluginSidebarProject, PluginSidebarThread, PluginThreadActionEntry, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import type { RenderedSlot, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { ARCHIVE_THREAD_ACTION } from "../hooks/use-sidebar-thread-actions";
import type { BotMetadata } from "../contract";

export function thread(id: string, updatedAt: number, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId: "project", title: `Conversation ${id}`, titleFallback: null, displayTitle: `Conversation ${id}`, parentThreadId: null, sectionId: null,
    lifecycleOwnerThreadId: null, sourceThreadId: null, status: "idle", runtimeStatus: "idle", queuedWork: "none",
    originKind: null, originPluginId: null, providerId: "pi", hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/threads/${id}`, isHidden: false,
    environment: { id: "env-existing", name: null, branchName: "feature", path: "/tmp/env-existing", isWorktree: true, providerId: null, workspaceDisplayKind: "managed-worktree" },
    host: { id: "host", name: "Local" }, createdAt: updatedAt, updatedAt, lastReadAt: updatedAt, latestAttentionAt: updatedAt,
    ...overrides,
  };
}
export function sidebarProject(id: string, name: string, isPersonal = false): PluginSidebarProject {
  return { id, name, isPersonal, href: `/projects/${id}`, settingsHref: `/projects/${id}/settings` };
}
export const bot: BotMetadata = {
  id: "bot", name: "Test bot", role: "Assistant", hiddenUntilActivity: false, hiddenAt: null, mainThreadId: "main",
  avatar: { color: "#168b75", shape: "round", expression: "curious", motion: "still" },
  sectionId: null, order: 0, hostId: "host", stateReady: true, legacyHomeProjectId: null, linkedProjectIds: ["project"],
  soul: "", agents: "", memory: "", settings: {}, updatedAt: 1, legacyProjectId: "project",
  stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null },
};
export const personalProjectId = "personal";
export const personalEnvironment: NewThreadRequest["environment"] = { type: "host", hostId: "host", workspace: { type: "personal" } };
export const request: NewThreadRequest = {
  projectId: "project", providerId: "pi", model: "test-model", reasoningLevel: "high", permissionMode: "accept-edits",
  executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
  environment: { type: "host", hostId: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } } },
  input: [
    { type: "text", text: "Review @Main", mentions: [{ start: 7, end: 12, resource: { kind: "thread", label: "Main", threadId: "main", projectId: "project" } }] },
    { type: "localFile", path: "attachments/spec.md", name: "spec.md", mimeType: "text/markdown", sizeBytes: 200 },
  ],
};

export type SidebarActionCall =
  | { method: "archive"; threadId: string }
  | { method: "rename"; threadId: string; title: string }
  | { method: "setRead"; threadId: string; read: boolean }
  | { method: "open"; threadId: string; options?: { split?: boolean } }
  | { method: "openNewThread"; options?: { projectId?: string; focusPrompt?: boolean } };

/**
 * renderSlot options faking bb's native archive action and the thread API calls the
 * sidebar makes. Pass `host.options` to renderSlot and `host.track(slot)`; read calls with `sidebarActionCalls`.
 */
export function threadActionHost() {
  const calls: SidebarActionCall[] = [];
  const record = (call: SidebarActionCall) => { calls.push(call); return Promise.resolve({} as never); };
  const options = {
    threadActions: (target: PluginThreadActionTarget): PluginThreadActionEntry[] => [{
      key: ARCHIVE_THREAD_ACTION, pluginId: "bb--core", group: "4_lifecycle",
      action: { label: "Archive", icon: "Archive", run: async () => { calls.push({ method: "archive", threadId: target.id }); } },
    }],
    sdk: { threads: {
      update: ({ threadId, title }: { threadId: string; title?: string | null }) => record({ method: "rename", threadId, title: title ?? "" }),
      markRead: ({ threadId }: { threadId: string }) => record({ method: "setRead", threadId, read: true }),
      markUnread: ({ threadId }: { threadId: string }) => record({ method: "setRead", threadId, read: false }),
    } },
  } satisfies Pick<RenderSlotOptions, "threadActions" | "sdk">;
  return { calls, options, track(slot: RenderedSlot) { actionCalls.set(slot, calls); } };
}
const actionCalls = new WeakMap<RenderedSlot, SidebarActionCall[]>();

/** The SDK 0.4 sidebarActionCalls view: host thread actions, then thread and compose navigation. */
export function sidebarActionCalls(slot: RenderedSlot): SidebarActionCall[] {
  const calls = actionCalls.get(slot);
  if (!calls) throw new Error("Render the slot with threadActionHost() options and track it.");
  return [...calls, ...slot.inspection.navigateCalls.flatMap((call): SidebarActionCall[] =>
    call.method === "toThread" ? [{ method: "open", threadId: call.threadId, options: call.options }]
      : call.method === "toCompose" ? [{ method: "openNewThread", options: call.options }] : [])];
}
