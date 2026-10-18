import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { BotMetadata, BotSection, rpcContract } from "../contract";
import { EMPTY_HASHES, nextTimestamp, type BotStore } from "./bot-store";
import { applyState, BotStateConflictError, stateContent, type createPrivateBotState } from "./private-state";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

export type BotCreateInput = z.infer<typeof rpcContract.bot_create.input>;
export type BotUpdateInput = z.infer<typeof rpcContract.bot_update.input>;
export type ProjectRoleAction = "join" | "leave" | "own" | "release";
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
/** What starting a bot conversation needs: a project, an environment and the first message. */
export type ConversationStart = Pick<SpawnArgs, "projectId" | "environment"> & Partial<Omit<SpawnArgs, "projectId" | "environment" | "input" | "prompt">> & {
  input: Extract<SpawnArgs, { input: unknown }>["input"];
};

export interface BotServiceDeps {
  bb: BbPluginApi;
  store: BotStore;
  state: ReturnType<typeof createPrivateBotState>;
  publish: () => void;
  importLegacy: () => Promise<string[]>;
  serial: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  personalProjectId: () => Promise<string>;
}

/**
 * Every bot write the sidebar, the `bb bots` CLI and the bots' own tools share:
 * validation, locking ("registry" for cross-bot changes, the bot id for one
 * bot), optimistic concurrency, private-state mirroring and the realtime ping.
 */
export function createBotService({ bb, store, state, publish, importLegacy, serial, personalProjectId }: BotServiceDeps) {
  async function validateLinks(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new Error("A project can only be linked once");
    const projects = await bb.sdk.projects.list();
    const legacyHomes = new Set(store.list().map((bot) => bot.legacyHomeProjectId));
    for (const id of ids) {
      if (!projects.some((project) => project.id === id && project.kind === "standard") || legacyHomes.has(id)) throw new Error("Link an existing work project, not a legacy bot home");
    }
  }
  function validateSection(id: string | null) {
    if (id !== null && !store.sections().some((section) => section.id === id)) throw new Error("Section no longer exists");
  }
  async function validateHost(hostId: string) {
    if (!(await bb.sdk.hosts.list()).some((host) => host.id === hostId)) throw new Error("Choose an enrolled execution machine");
  }
  async function validateConversationProject(bot: BotMetadata, projectId: string) {
    if (projectId !== await personalProjectId() && !bot.linkedProjectIds.includes(projectId)) throw new Error("Choose a projectless conversation or link this project to the bot first");
  }

  function createBot({ name, role, hostId, avatar, sectionId, linkedProjectIds, ownedProjectIds, soul, memory, settings, launchPreset }: BotCreateInput): Promise<BotMetadata> {
    return serial("registry", async () => {
      await importLegacy(); await validateLinks(linkedProjectIds); if (ownedProjectIds) await validateLinks(ownedProjectIds); validateSection(sectionId);
      await validateHost(hostId);
      const id = `bot_${randomUUID().replaceAll("-", "")}`;
      let created: BotMetadata = { id, name, role, hostId, stateReady: true, legacyHomeProjectId: null, avatar, sectionId, linkedProjectIds, soul, agents: "", memory: "", settings: {}, stateHashes: { ...EMPTY_HASHES }, order: store.list().length, mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null, updatedAt: Date.now(), legacyProjectId: null };
      if (launchPreset !== undefined) created.launchPreset = launchPreset;
      if (memory !== undefined) created = applyState(created, "MEMORY.md", memory);
      if (settings !== undefined) created = applyState(created, "settings.json", stateContent({ ...created, settings }, "settings.json"));
      store.saveWithProjects(created, ownedProjectIds);
      const ready = await state.prepare(id); publish(); return ready;
    });
  }

  function updateBot({ botId, expectedUpdatedAt, expectedStateHashes, ownedProjectIds, memory, settings, ...fields }: BotUpdateInput): Promise<BotMetadata> {
    return serial("registry", () => serial(botId, async () => {
      const bot = await state.prepare(botId);
      if (bot.updatedAt !== expectedUpdatedAt) throw new Error("Bot changed while editing. Reopen the editor or read identity again to avoid overwriting newer changes.");
      if (JSON.stringify(fields.linkedProjectIds) !== JSON.stringify(bot.linkedProjectIds)) await validateLinks(fields.linkedProjectIds);
      if (ownedProjectIds) {
        const existingOwned = new Set(store.ownedProjects(botId));
        await validateLinks(ownedProjectIds.filter((id) => !existingOwned.has(id)));
      }
      if (fields.hostId !== undefined && fields.hostId !== bot.hostId) await validateHost(fields.hostId);
      validateSection(fields.sectionId);
      const next = store.mutateWithProjects(botId, (current) => {
        if (current.updatedAt !== expectedUpdatedAt) throw new Error("Bot changed while editing. Read the current identity before saving.");
        let next = { ...current, ...fields };
        if (memory !== undefined) next = applyState(next, "MEMORY.md", memory);
        if (settings !== undefined) next = applyState(next, "settings.json", stateContent({ ...next, settings }, "settings.json"));
        for (const file of ["SOUL.md", "MEMORY.md", "settings.json"] as const) {
          if (stateContent(next, file) === stateContent(current, file)) continue;
          if (current.stateHashes[file] !== expectedStateHashes[file]) throw new BotStateConflictError(`${file} changed while editing. Read the current state before saving.`);
        }
        return {
          ...next,
          stateHashes: {
            ...current.stateHashes,
            "SOUL.md": sha256(next.soul),
            ...(memory !== undefined ? { "MEMORY.md": sha256(next.memory) } : {}),
            ...(settings !== undefined ? { "settings.json": sha256(stateContent(next, "settings.json")) } : {}),
          },
          updatedAt: nextTimestamp(current.updatedAt),
        };
      }, ownedProjectIds);
      await state.mirror(next); publish(); return next;
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
    return serial("registry", async () => {
      const saved = store.sections();
      const section = { id: randomUUID(), name, order: saved.length };
      store.saveSections([...saved, section]); publish(); return section;
    });
  }
  function renameSection(sectionId: string, name: string): Promise<BotSection> {
    return serial("registry", async () => {
      const saved = store.sections(); const section = saved.find((entry) => entry.id === sectionId);
      if (!section) throw new Error("Section no longer exists");
      const next = { ...section, name }; store.saveSections(saved.map((entry) => entry.id === sectionId ? next : entry)); publish(); return next;
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
    validateLinks, validateSection, validateConversationProject,
    createBot, updateBot, changeProjectRole,
    createSection, renameSection, deleteSection, setVisibility, startConversation,
  };
}
export type BotService = ReturnType<typeof createBotService>;
