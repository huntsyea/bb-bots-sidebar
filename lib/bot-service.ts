import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotAvatar, BotMetadata, BotSection } from "../contract";
import type { BotChangeBlocker, BotChangeSummary } from "./bot-change-approval";
import { writeBotExport } from "./bot-export";
import type { LaunchPreset } from "./launch-preset";
import { EMPTY_HASHES, nextTimestamp, type BotStore } from "./bot-store";
import { applyState, BotStateConflictError, stateContent, type createPrivateBotState } from "./private-state";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

export type ProjectRoleAction = "join" | "leave" | "own" | "release";
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
/** What starting a bot conversation needs: a project, an environment and the first message. */
export type ConversationStart = Pick<SpawnArgs, "projectId" | "environment"> & Partial<Omit<SpawnArgs, "projectId" | "environment" | "input" | "prompt">> & {
  input: Extract<SpawnArgs, { input: unknown }>["input"];
};

/** What a bot is, as one change can set it. Omitted fields keep their current value. */
export interface BotFields {
  name: string; role: string; soul: string; hostId: string; avatar: BotAvatar;
  sectionId: string | null; linkedProjectIds: string[]; ownedProjectIds: string[];
  /** Hidden in the sidebar until the bot has activity. */
  hidden: boolean;
  memory: string; settings: BotMetadata["settings"]; launchPreset: LaunchPreset | null;
}
export type BotChange =
  | ({ kind: "create" } & Pick<BotFields, "name" | "hostId" | "avatar"> & Partial<Omit<BotFields, "name" | "hostId" | "avatar">>)
  | ({
    kind: "update"; botId: string;
    /** The bot's `updatedAt` when the caller read it; any later write makes the change fail. */
    revision: number;
    /** The sidebar editor's per-file preconditions (the `bot_update` RPC contract). */
    expectedStateHashes?: BotMetadata["stateHashes"];
  } & Partial<BotFields>)
  /** Removes the bot after writing its export; its conversations become ordinary threads. */
  | { kind: "delete"; botId: string; revision: number };

export interface CheckedBotChange {
  botId: string | null;
  /** Fields that differ from the current bot; every given field for a new bot. */
  changed: (keyof BotFields)[];
  summary: BotChangeSummary;
  /** Reasons a delete can't run yet. Creates and updates refuse with BotChangeRejected instead. */
  blockers: BotChangeBlocker[];
}

/** A change the bot write module refuses, with a stable code for CLI output. */
export class BotChangeRejected extends Error {
  override name = "BotChangeRejected";
  constructor(readonly code: string, message: string) { super(message); }
}

export interface BotServiceDeps {
  bb: BbPluginApi;
  store: BotStore;
  state: ReturnType<typeof createPrivateBotState>;
  publish: () => void;
  importLegacy: () => Promise<string[]>;
  serial: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  personalProjectId: () => Promise<string>;
}

const IDENTITY_LIMITS = { name: 120, role: 80, soul: 4096 };
const STATE_FILES = ["SOUL.md", "MEMORY.md", "settings.json"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: string[], b: string[]) => same([...a].sort(), [...b].sort());

/**
 * Every bot write the sidebar, the `bb bots` CLI and the bots' own tools share:
 * validation, locking ("registry" for cross-bot changes, the bot id for one
 * bot), optimistic concurrency, private-state mirroring and the realtime ping.
 *
 * A bot change is checked as a whole before it runs: `checkBotChange` says what
 * it would do or why it would fail, and `applyBotChange` checks it, lets the
 * caller confirm the checked change, then checks again under the locks and
 * writes. After a confirmation, a write fails only if something changed since.
 */
export function createBotService({ bb, store, state, publish, importLegacy, serial, personalProjectId }: BotServiceDeps) {
  // Bots with a change waiting on its caller's confirmation (an approval form).
  const confirming = new Map<string, number>();
  // ── Rules. Exported validators serve upstream's RPC handlers in server.ts. ──
  async function linkProblem(ids: string[]): Promise<string | null> {
    if (new Set(ids).size !== ids.length) return "A project can only be linked once";
    const projects = await bb.sdk.projects.list();
    const legacyHomes = new Set(store.list().map((bot) => bot.legacyHomeProjectId));
    const invalid = ids.some((id) => !projects.some((project) => project.id === id && project.kind === "standard") || legacyHomes.has(id));
    return invalid ? "Link an existing work project, not a legacy bot home" : null;
  }
  async function validateLinks(ids: string[]) {
    const problem = await linkProblem(ids);
    if (problem) throw new Error(problem);
  }
  function validateSection(id: string | null) {
    if (id !== null && !store.sections().some((section) => section.id === id)) throw new Error("Section no longer exists");
  }
  async function validateConversationProject(bot: BotMetadata, projectId: string) {
    if (projectId !== await personalProjectId() && !bot.linkedProjectIds.includes(projectId)) throw new Error("Choose a projectless conversation or link this project to the bot first");
  }
  function sectionName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) throw new BotChangeRejected("invalid_section_name", "Section names have 1-80 characters.");
    return trimmed;
  }

  /** What deleting a bot would remove, and what blocks it. Reads only. */
  async function draftDelete(change: Extract<BotChange, { kind: "delete" }>): Promise<CheckedBotChange> {
    const bot = store.get(change.botId);
    if (!bot) throw new BotChangeRejected("bot_not_found", "Bot no longer exists");
    if (bot.updatedAt !== change.revision) throw new BotChangeRejected("bot_changed", "Bot changed since it was read. Check the delete again.");
    const names = new Map((await bb.sdk.projects.list()).map((project) => [project.id, project.name]));
    const owned = store.ownedProjects(bot.id);
    const blockers: BotChangeBlocker[] = owned.map((projectId) => ({
      code: "project_owned",
      message: `${bot.name} owns ${names.get(projectId) ?? "Unavailable project"} (${projectId}). Release it first with bb bots projects release ${bot.id} ${projectId}, or leave it with bb bots projects leave ${bot.id} ${projectId}.`,
    }));
    if (confirming.get(bot.id)) blockers.push({ code: "approval_pending", message: `A bot change approval is pending for ${bot.name}. Answer or dismiss it first.` });
    const section = bot.sectionId === null ? null : store.sections().find((entry) => entry.id === bot.sectionId) ?? null;
    const ownedSet = new Set(owned);
    return {
      botId: bot.id, changed: [], blockers,
      summary: {
        kind: "delete", name: bot.name, role: bot.role, soul: bot.soul, sectionId: section?.id ?? null, section: section?.name ?? null,
        linkedProjectIds: bot.linkedProjectIds, ownedProjectIds: owned, hidden: bot.hiddenUntilActivity,
        projects: bot.linkedProjectIds.map((id) => ({ id, name: names.get(id) ?? "Unavailable project", owner: ownedSet.has(id) })),
        previous: { name: bot.name, role: bot.role, soul: bot.soul },
        removal: {
          memoryCharacters: bot.memory.length, settingsKeys: Object.keys(bot.settings).sort(),
          conversationCount: store.bindings().filter((binding) => binding.botId === bot.id).length,
        },
      },
    };
  }
  function refuseBlocked(checked: CheckedBotChange) {
    const [first] = checked.blockers;
    if (first) throw new BotChangeRejected(first.code, checked.blockers.map((blocker) => blocker.message).join(" "));
  }

  /** The bot a change would produce, or the reason it can't be made. Reads only. */
  async function draft(change: Exclude<BotChange, { kind: "delete" }>) {
    const reject = (code: string, message: string): never => { throw new BotChangeRejected(code, message); };
    const current = change.kind === "update" ? store.get(change.botId) : null;
    if (change.kind === "update") {
      if (!current) reject("bot_not_found", "Bot no longer exists");
      if (current!.updatedAt !== change.revision) reject("bot_changed", "Bot changed while editing. Reopen the editor or read identity again to avoid overwriting newer changes.");
    }
    const previousOwned = current ? store.ownedProjects(current.id) : [];
    const name = (change.name ?? current?.name ?? "").trim();
    const role = (change.role ?? current?.role ?? "").trim();
    const soul = change.soul ?? current?.soul ?? "";
    if (!name || name.length > IDENTITY_LIMITS.name) reject("invalid_name", "Bot names have 1-120 characters.");
    if (role.length > IDENTITY_LIMITS.role) reject("invalid_role", "Roles have at most 80 characters.");
    if (soul.length > IDENTITY_LIMITS.soul) reject("invalid_soul", "Instructions (SOUL) have at most 4096 characters.");
    const sectionId = change.sectionId !== undefined ? change.sectionId : current?.sectionId ?? null;
    const section = sectionId === null ? null : store.sections().find((entry) => entry.id === sectionId) ?? null;
    if (sectionId !== null && !section) reject("section_not_found", "Section no longer exists");
    const hostId = change.hostId ?? current!.hostId;
    if ((!current || hostId !== current.hostId) && !(await bb.sdk.hosts.list()).some((host) => host.id === hostId)) reject("machine_not_found", "Choose an enrolled execution machine");

    const linkedProjectIds = change.linkedProjectIds ?? current?.linkedProjectIds ?? [];
    // Unlinking a project without naming owners releases its ownership, as the store does.
    const ownedProjectIds = change.ownedProjectIds ?? previousOwned.filter((id) => linkedProjectIds.includes(id));
    const linkChecks = current
      ? [...(same(linkedProjectIds, current.linkedProjectIds) ? [] : [linkedProjectIds]), ownedProjectIds.filter((id) => !previousOwned.includes(id))]
      : [linkedProjectIds, ownedProjectIds];
    for (const ids of linkChecks) {
      const problem = ids.length ? await linkProblem(ids) : null;
      if (problem) reject("invalid_project", problem);
    }
    if (new Set(ownedProjectIds).size !== ownedProjectIds.length || ownedProjectIds.some((id) => !linkedProjectIds.includes(id))) reject("invalid_project", "Every owned project must be linked exactly once");
    for (const projectId of ownedProjectIds) {
      const owner = store.projectOwner(projectId);
      if (owner && owner.botId !== current?.id) reject("project_owned", `Project already owned by ${store.get(owner.botId)?.name ?? owner.botId}. Release that ownership first.`);
    }

    const base: BotMetadata = current ?? {
      id: "", name, role, hostId, stateReady: true, legacyHomeProjectId: null, avatar: change.avatar!, sectionId, linkedProjectIds, soul, agents: "", memory: "", settings: {},
      stateHashes: { ...EMPTY_HASHES }, order: 0, mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null, updatedAt: 0, legacyProjectId: null,
    };
    const hidden = change.hidden ?? base.hiddenUntilActivity;
    let next: BotMetadata = { ...base, name, role, soul, hostId, sectionId, linkedProjectIds, avatar: change.avatar ?? base.avatar, hiddenUntilActivity: hidden };
    if (change.launchPreset !== undefined) next.launchPreset = change.launchPreset;
    try {
      if (change.memory !== undefined) next = applyState(next, "MEMORY.md", change.memory);
      if (change.settings !== undefined) next = applyState(next, "settings.json", stateContent({ ...next, settings: change.settings }, "settings.json"));
    } catch (error) { reject("invalid_state", error instanceof Error ? error.message : String(error)); }
    if (current && change.kind === "update" && change.expectedStateHashes) {
      for (const file of STATE_FILES) {
        if (stateContent(next, file) === stateContent(current, file)) continue;
        if (current.stateHashes[file] !== change.expectedStateHashes[file]) throw new BotStateConflictError(`${file} changed while editing. Read the current state before saving.`);
      }
    }

    const differs: Record<keyof BotFields, boolean> = {
      name: name !== base.name, role: role !== base.role, soul: soul !== base.soul, hostId: hostId !== base.hostId,
      avatar: !same(next.avatar, base.avatar), sectionId: sectionId !== base.sectionId,
      linkedProjectIds: !same(linkedProjectIds, base.linkedProjectIds), ownedProjectIds: !sameSet(ownedProjectIds, previousOwned),
      hidden: hidden !== base.hiddenUntilActivity, memory: next.memory !== base.memory,
      settings: stateContent(next, "settings.json") !== stateContent(base, "settings.json"), launchPreset: !same(next.launchPreset, base.launchPreset),
    };
    const changed = (Object.keys(differs) as (keyof BotFields)[]).filter((key) => current ? differs[key] : change[key] !== undefined);
    const names = new Map((await bb.sdk.projects.list()).map((project) => [project.id, project.name]));
    const owned = new Set(ownedProjectIds);
    const summary: BotChangeSummary = {
      kind: change.kind, name, role, soul, sectionId, section: section?.name ?? null, linkedProjectIds, ownedProjectIds,
      projects: linkedProjectIds.map((id) => ({ id, name: names.get(id) ?? "Unavailable project", owner: owned.has(id) })), hidden,
      ...(current ? { previous: { name: current.name, role: current.role, soul: current.soul } } : {}),
    };
    return { current, next, ownedProjectIds, checked: { botId: current?.id ?? null, changed, summary, blockers: [] } satisfies CheckedBotChange };
  }

  /** What a change would do, or a BotChangeRejected saying why it would fail. Writes nothing. */
  async function checkBotChange(change: BotChange): Promise<CheckedBotChange> {
    return change.kind === "delete" ? draftDelete(change) : (await draft(change)).checked;
  }

  /**
   * Checks and makes a change. `confirm` sees the checked change before any
   * write and may throw to stop it (the approval form); no lock is held while
   * it runs. The change is then checked again under the locks.
   */
  async function applyBotChange(change: BotChange, { confirm }: { confirm?: (checked: CheckedBotChange) => Promise<void> } = {}): Promise<{ checked: CheckedBotChange; bot: BotMetadata; exportPath?: string }> {
    if (confirm) {
      const checked = await checkBotChange(change);
      refuseBlocked(checked);
      const botId = change.kind === "create" ? null : change.botId;
      if (botId) confirming.set(botId, (confirming.get(botId) ?? 0) + 1);
      try { await confirm(checked); } finally {
        if (botId) { const left = (confirming.get(botId) ?? 1) - 1; if (left) confirming.set(botId, left); else confirming.delete(botId); }
      }
    }
    if (change.kind === "delete") {
      return serial("registry", () => serial(change.botId, async () => {
        const checked = await draftDelete(change);
        refuseBlocked(checked);
        const bot = store.require(change.botId);
        // The export is written and read back before anything is deleted.
        const exportPath = writeBotExport(join(dirname(store.databasePath), "state"), {
          deletedAt: new Date().toISOString(), bot,
          bindings: store.bindings().filter((binding) => binding.botId === bot.id).map((binding) => binding.threadId),
          ownedProjectIds: store.ownedProjects(bot.id),
          legacy: { state: store.state(`legacy-state:${bot.id}`), record: store.state(`legacy-record:${bot.id}`) },
        });
        store.remove(bot.id); publish();
        return { checked, bot, exportPath };
      }));
    }
    if (change.kind === "create") {
      return serial("registry", async () => {
        await importLegacy();
        const { next, ownedProjectIds, checked } = await draft(change);
        const id = `bot_${randomUUID().replaceAll("-", "")}`;
        store.saveWithProjects({ ...next, id, order: store.list().length, hiddenAt: next.hiddenUntilActivity ? Date.now() : null, updatedAt: Date.now() }, ownedProjectIds);
        const bot = await state.prepare(id); publish();
        return { checked: { ...checked, botId: id }, bot };
      });
    }
    return serial("registry", () => serial(change.botId, async () => {
      await state.prepare(change.botId);
      const { current, next, checked } = await draft(change);
      if (!checked.changed.length) return { checked, bot: current! };
      const bot = store.mutateWithProjects(change.botId, (latest) => {
        if (latest.updatedAt !== change.revision) throw new BotChangeRejected("bot_changed", "Bot changed while editing. Read the current identity before saving.");
        return {
          ...next,
          hiddenAt: checked.changed.includes("hidden") ? (next.hiddenUntilActivity ? Date.now() : null) : latest.hiddenAt,
          stateHashes: {
            ...latest.stateHashes,
            "SOUL.md": sha256(next.soul),
            ...(change.memory !== undefined ? { "MEMORY.md": sha256(next.memory) } : {}),
            ...(change.settings !== undefined ? { "settings.json": sha256(stateContent(next, "settings.json")) } : {}),
          },
          updatedAt: nextTimestamp(latest.updatedAt),
        };
      }, checked.changed.includes("ownedProjectIds") ? change.ownedProjectIds : undefined);
      await state.mirror(bot); publish();
      return { checked, bot };
    }));
  }

  function changeProjectRole(botId: string, action: ProjectRoleAction, projectId: string) {
    return serial("registry", () => serial(botId, async () => {
      store.require(botId);
      if (action === "join" || action === "own") await validateLinks([projectId]);
      const result = store.changeProjectRole(botId, projectId, action);
      if (result.changed) { await state.mirror(result.bot); publish(); }
      return result;
    }));
  }

  function createSection(name: string): Promise<BotSection> {
    const checkedName = sectionName(name);
    return serial("registry", async () => {
      const saved = store.sections();
      const section = { id: randomUUID(), name: checkedName, order: saved.length };
      store.saveSections([...saved, section]); publish(); return section;
    });
  }
  function renameSection(sectionId: string, name: string): Promise<BotSection> {
    const checkedName = sectionName(name);
    return serial("registry", async () => {
      const saved = store.sections(); const section = saved.find((entry) => entry.id === sectionId);
      if (!section) throw new Error("Section no longer exists");
      const next = { ...section, name: checkedName }; store.saveSections(saved.map((entry) => entry.id === sectionId ? next : entry)); publish(); return next;
    });
  }
  /** Bots in the section move to Main; the bots themselves are untouched. */
  function deleteSection(sectionId: string): Promise<void> {
    return serial("registry", async () => {
      validateSection(sectionId);
      store.saveAll(store.list().filter((bot) => bot.sectionId === sectionId).map((bot) => ({ ...bot, sectionId: null, updatedAt: nextTimestamp(bot.updatedAt) })));
      store.saveSections(store.sections().filter((section) => section.id !== sectionId)); publish();
    });
  }

  /** The sidebar's eye toggle: last write wins, like upstream's `visibility_set`. */
  function setVisibility(botId: string, hiddenUntilActivity: boolean): Promise<BotMetadata> {
    return serial(botId, async () => {
      const bot = store.require(botId);
      const next = store.save({ ...bot, hiddenUntilActivity, hiddenAt: hiddenUntilActivity ? Date.now() : null, updatedAt: nextTimestamp(bot.updatedAt) });
      publish(); return next;
    });
  }

  /**
   * Starts a conversation bound to the bot. A work project joins the bot first;
   * the start token lets the dispatch hook bind the thread before its first turn.
   */
  async function startConversation({ botId, request, makeMain }: { botId: string; request: ConversationStart; makeMain?: boolean }): Promise<{ threadId: string }> {
    if (request.projectId !== await personalProjectId()) await changeProjectRole(botId, "join", request.projectId);
    return serial(botId, async () => {
      const bot = await state.prepare(botId);
      await validateConversationProject(bot, request.projectId);
      const token = randomUUID(); store.stageStart(token, botId, request.projectId);
      const thread = await bb.sdk.threads.spawn({ ...request, input: [...request.input, { type: "text", text: `[bb-bot-start:${token}]\nThis conversation belongs to bot ${bot.name}. Its identity and memory are embedded and managed by bot_read_state / bot_update_state, not files in the working directory.`, mentions: [], visibility: "agent-only" }] });
      store.bind(thread.id, botId); store.cancelStart(token);
      if (makeMain || !store.require(botId).mainThreadId) { const latest = store.require(botId); store.save({ ...latest, mainThreadId: thread.id, updatedAt: nextTimestamp(latest.updatedAt) }); }
      publish(); return { threadId: thread.id };
    });
  }

  return {
    checkBotChange, applyBotChange,
    changeProjectRole, createSection, renameSection, deleteSection, setVisibility, startConversation,
    // For upstream's RPC handlers and dispatch hook in server.ts.
    validateLinks, validateSection, validateConversationProject,
  };
}
export type BotService = ReturnType<typeof createBotService>;
