import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { rpcContract, stateReadSchema, stateMutationSchema, stateMutationToolSchema, stateMutationResultSchema, normalizeStateMutation, type BotMetadata, type BotStateMutation } from "./contract";
import { createBotStore, nextTimestamp } from "./lib/bot-store";
import { BotStateConflictError, createPrivateBotState } from "./lib/private-state";
import { memoryFacts, mutateStateDocument } from "./lib/state-actions";
import { createLegacyImporter } from "./lib/migrate-bots";
import { browseProjectDirectory, createWorkProject } from "./lib/project-creation";
import { registerBotsCli } from "./lib/bots-cli";
import { createBotService } from "./lib/bot-service";
import { registerBotMentions } from "./lib/bot-mentions";
import { listBotConversations } from "./lib/bot-conversations";
import { botProjectContext } from "./lib/project-context";
import { BOT_GUIDANCE, botInstructions } from "./lib/bot-instructions";
import { MEMORY_MAX_CHARS, validateMemory } from "./lib/memory-limit";
import { providerForMode, rememberedThreadsProvider } from "./lib/sidebar-mode";
export { rpcContract, avatarSchema } from "./contract";
export type { BotAvatar, BotMetadata, BotSection, ProjectCreateInput } from "./contract";

const CHANGED = "project-bots-changed";
const START_MARKER = /^\[bb-bot-start:([a-f0-9-]{36})\]/;

export default async function plugin(bb: BbPluginApi) {
  const store = createBotStore(bb);
  const publish = () => bb.realtime.publish(CHANGED, { updatedAt: Date.now() });
  const state = createPrivateBotState(bb, store, publish);
  const importLegacy = createLegacyImporter(bb, store);
  let personalId: string | null = null;
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, run);
    void run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
    return run;
  }
  async function personalProjectId() {
    if (personalId) return personalId;
    const project = (await bb.sdk.projects.list({ includePersonal: true })).find((project) => project.kind === "personal");
    if (!project) throw new Error("BB's personal project is unavailable");
    personalId = project.id;
    return personalId;
  }
  // Configuration may inspect a fork before its creation handler finishes.
  // Keep reads pure so they cannot preempt the atomic inherited bind + join.
  function owner(context: { id: string; parentThreadId?: string | null; sourceThreadId?: string | null }) {
    const explicit = store.owner(context.id);
    if (explicit) return explicit;
    const inherited = (context.parentThreadId && store.owner(context.parentThreadId)) || (context.sourceThreadId && store.owner(context.sourceThreadId));
    return inherited || null;
  }
  async function resolveOwner(threadId: string, persist = true): Promise<string | null> {
    const chain: string[] = [];
    let current: string | null = threadId;
    let botId: string | null = null;
    while (current && !chain.includes(current)) {
      const explicit = store.owner(current);
      if (explicit) { botId = explicit; break; }
      const thread = await bb.sdk.threads.get({ threadId: current });
      chain.push(current);
      botId = (thread.parentThreadId && store.owner(thread.parentThreadId)) || (thread.sourceThreadId && store.owner(thread.sourceThreadId)) || null;
      if (botId) break;
      current = thread.parentThreadId ?? thread.sourceThreadId;
    }
    if (botId && persist) for (const id of chain) store.bind(id, botId);
    return botId;
  }
  const botService = createBotService({ bb, store, state, publish, importLegacy, serial, personalProjectId });
  type RoutingThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  async function routeNewThread(thread: RoutingThread, atCreation: boolean) {
    const existing = store.owner(thread.id);
    if (existing) return existing;
    // Our creation request carries a durable explicit choice. A fire-and-forget
    // creation event must not let the project default claim it before dispatch.
    if (atCreation && thread.originPluginId === bb.pluginId) return null;
    const inherited = thread.parentThreadId || thread.sourceThreadId ? await resolveOwner(thread.id, false) : null;
    if (inherited) {
      let projectToJoin: string | null = null;
      if (atCreation || thread.status === "pending") {
        const projects = await bb.sdk.projects.list();
        const legacyHome = store.list().some((bot) => bot.legacyHomeProjectId === thread.projectId);
        if (!legacyHome && projects.some((project) => project.id === thread.projectId && project.kind === "standard")) projectToJoin = thread.projectId;
      }
      const adopted = store.adoptInherited(thread.id, inherited, projectToJoin);
      if (adopted.joined) await state.mirror(store.require(adopted.botId));
      if (adopted.changed) publish();
      return adopted.botId;
    }
    if (thread.originPluginId === bb.pluginId || (!atCreation && thread.status !== "pending")) return null;
    const assigned = store.bindProjectDefault(thread.id, thread.projectId, thread.createdAt);
    if (assigned) publish();
    return assigned;
  }

  type StateResult = z.infer<typeof stateMutationResultSchema>;
  type StateView = Omit<StateResult, "changed">;
  function identityView(bot: BotMetadata): StateView {
    return { botId: bot.id, target: "identity", revision: bot.updatedAt, state: { name: bot.name, role: bot.role, soul: bot.soul } };
  }
  async function projectView(bot: BotMetadata, currentProjectId?: string): Promise<StateView> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const legacyHomes = new Set(store.list().map((entry) => entry.legacyHomeProjectId));
    const ownership = (id: string) => { const entry = store.projectOwner(id); return { ownerBotId: entry?.botId ?? null, ownerName: entry ? store.require(entry.botId).name : null }; };
    const available = projects.filter((project) => project.kind === "standard" && !legacyHomes.has(project.id)).map((project) => ({ id: project.id, name: project.name, ...ownership(project.id) }));
    const current = projects.find((project) => project.id === currentProjectId);
    return { botId: bot.id, target: "project", revision: bot.updatedAt, state: { ...(currentProjectId ? { currentProject: current ? botProjectContext(bot, current, store) : null } : {}), linked: bot.linkedProjectIds.map((id) => ({ id, name: projects.find((project) => project.id === id)?.name ?? "Unavailable project", role: store.projectOwner(id)?.botId === bot.id ? "owner" : "member", ...ownership(id) })), available: available.slice(0, 200), availableCount: available.length } };
  }
  function documentView(bot: BotMetadata, target: "memory" | "settings", document: { content: string; sha256: string }): StateView {
    return { botId: bot.id, target, revision: bot.updatedAt, state: target === "memory" ? { ...document, facts: memoryFacts(document.content), characters: document.content.length, maxCharacters: MEMORY_MAX_CHARS } : { sha256: document.sha256, values: JSON.parse(document.content) } };
  }
  async function readBotState(botId: string, input: z.infer<typeof stateReadSchema>, currentProjectId?: string) {
    return serial(botId, async () => {
      if (input.target === "project") return projectView(store.require(botId), currentProjectId);
      const bot = await state.prepare(botId);
      if (input.target === "identity") return identityView(bot);
      return documentView(bot, input.target, await state.read(bot, input.target === "memory" ? "MEMORY.md" : "settings.json"));
    });
  }
  async function applyBotState(botId: string, change: BotStateMutation): Promise<StateResult> {
    if (change.target === "identity") {
      const bot = await serial(botId, () => state.prepare(botId));
      if (bot.updatedAt !== change.expectedRevision) throw new Error("Identity changed. Read identity again and merge your update.");
      const fields = { name: change.name ?? bot.name, role: change.role ?? bot.role, soul: change.soul ?? bot.soul };
      if (Object.entries(fields).every(([key, value]) => bot[key as keyof typeof fields] === value)) return { ...identityView(bot), changed: false };
      const next = await botService.updateBot({ ...fields, botId, avatar: bot.avatar, sectionId: bot.sectionId, linkedProjectIds: bot.linkedProjectIds, expectedUpdatedAt: change.expectedRevision, expectedStateHashes: bot.stateHashes });
      return { ...identityView(next), changed: true };
    }
    if (change.target === "project") {
      const result = await botService.changeProjectRole(botId, change.action, change.projectId);
      return { ...await projectView(result.bot), changed: result.changed };
    }
    return serial(botId, async () => {
      await state.prepare(botId);
      const file = change.target === "memory" ? "MEMORY.md" : "settings.json";
      if (change.target === "memory" && change.action === "overwrite") {
        // Whole-document replacements must never retry against a newer hash.
        const current = await state.read(store.require(botId), "MEMORY.md");
        validateMemory(change.content);
        if (current.sha256 !== change.expectedSha256) throw new BotStateConflictError('Memory changed. Read it again with bot_read_state({"target":"memory"}), condense the latest content, then overwrite using its sha256.');
        if (change.content === current.content) return { ...documentView(store.require(botId), "memory", current), changed: false };
        const written = await state.update(botId, "MEMORY.md", change.content, change.expectedSha256);
        return { ...documentView(store.require(botId), "memory", written), changed: true };
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const bot = store.require(botId);
        const current = await state.read(bot, file);
        const content = mutateStateDocument(current.content, change);
        if (change.target === "memory") validateMemory(content);
        if (content === current.content) return { ...documentView(bot, change.target, current), changed: false };
        try {
          const written = await state.update(botId, file, content, current.sha256);
          return { ...documentView(store.require(botId), change.target, written), changed: true };
        } catch (error) {
          if (!(error instanceof BotStateConflictError) || attempt === 2) throw error;
        }
      }
      throw new Error("State changed too often; read it again and retry");
    });
  }
  const contextOwner = (ctx: PluginAgentConfigurationContext) => owner(ctx.thread);
  bb.agents.configure((ctx) => {
    const botId = contextOwner(ctx);
    const bot = botId ? store.get(botId) : null;
    return bot ? { tools: ["bot_read_state", "bot_update_state"], skills: ["bots-sidebar"], instructions: botInstructions(bot, botProjectContext(bot, ctx.project, store)) } : { tools: [], skills: [] };
  });
  bb.agents.registerTool({
    name: "bot_read_state", description: "Read this bot's embedded identity and revision, memory facts, settings, or linked/available projects. Supply only target: identity, memory, settings, or project. State is managed privately by BB and is independent of the current machine or working directory.",
    instructions: BOT_GUIDANCE,
    parameters: stateReadSchema,
    execute: async (input, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      return JSON.stringify(await readBotState(botId, input, ctx.projectId));
    },
  });
  bb.agents.registerTool({
    name: "bot_update_state", description: "The durable-write gateway for this bot's private state. Always supply target and action. identity/set updates name, role or SOUL using expectedRevision from bot_read_state. memory/append or forget uses one exact single-line fact. Memory is limited to 3000 characters; if full, read memory, condense it, then use memory/overwrite with content and expectedSha256 from that read. Stale replacements fail; read and merge again. settings/set merges selected values; settings/unset removes selected keys. project/join adds membership; leave removes membership and releases ownership. project/own claims an unowned project and joins it; release keeps membership. One owner receives new project threads by default; explicit bot choices win. Existing conversations never move. Scope is always the current bot. State is stored by BB, not in the working directory; do not create state files in projects.",
    parameters: stateMutationToolSchema,
    execute: async (change, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      return JSON.stringify(await applyBotState(botId, stateMutationSchema.parse(normalizeStateMutation(change))));
    },
  });
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    for (const block of ctx.input.blocks) {
      if (block.type !== "text" || block.visibility !== "agent-only") continue;
      const token = block.text.match(START_MARKER)?.[1];
      if (!token || ctx.thread.originPluginId !== bb.pluginId) continue;
      const start = store.pendingStartContext(token);
      if (!start) continue;
      if (start.projectId === null) await botService.validateConversationProject(store.require(start.botId), ctx.thread.projectId);
      else if (start.projectId !== ctx.thread.projectId) throw new Error("Bot conversation start belongs to a different project");
      store.finishStart(token, ctx.thread.id); publish(); return { action: "proceed" };
    }
    await routeNewThread(ctx.thread, false);
    return { action: "proceed" };
  });
  bb.events.on("thread.created", async ({ thread }) => { await routeNewThread(thread, true); });

  const settings = bb.settings.define({
    agentBotChanges: {
      type: "select", label: "Agents may create bots", default: "ask",
      options: ["off", "ask", "allow"], experimental_optionLabels: { off: "Off", ask: "Ask", allow: "Allow" },
      description: "Applies when an agent runs bb bots create or update from a BB thread. Ask shows an approval form in that thread; Off refuses; Allow runs directly. Commands run from your own terminal outside BB always work. Agents use your shell, so this is a guardrail, not a security boundary.",
    },
  });
  registerBotsCli(bb, {
    store, service: botService, resolveOwner,
    agentBotChanges: async () => {
      const value = (await settings.get()).agentBotChanges;
      return value === "off" || value === "allow" ? value : "ask";
    },
  });
  registerBotMentions(bb, store);

  const THREAD_LIST_PROVIDER = "sidebar.threadListProvider" as const;
  // Key predates the Code → Threads rename; kept so the remembered list survives.
  const THREADS_PROVIDER_KEY = "sidebar:code-provider";
  // Read the active provider and remember it as the Threads tab's list whenever
  // it is not ours, so a choice made in Settings → Appearance sticks.
  const readThreadListProvider = async () => {
    const entry = (await bb.sdk.system.uiPreferences.list()).preferences[THREAD_LIST_PROVIDER];
    const stored = (await bb.storage.kv.get<string>(THREADS_PROVIDER_KEY)) ?? null;
    const threadsProvider = rememberedThreadsProvider(stored, entry.value);
    if (threadsProvider !== stored && threadsProvider !== null) await bb.storage.kv.set(THREADS_PROVIDER_KEY, threadsProvider);
    return { ...entry, threadsProvider };
  };

  bb.rpc.register(rpcContract, {
    sidebar_mode_get: async () => ({ provider: (await readThreadListProvider()).value }),
    sidebar_mode_set: async ({ mode }) => {
      const { revision, threadsProvider } = await readThreadListProvider();
      const result = await bb.sdk.system.uiPreferences.set({ key: THREAD_LIST_PROVIDER, value: providerForMode(mode, threadsProvider), expectedRevision: revision });
      return { provider: result.value };
    },
    project_browse: ({ hostId, path }) => browseProjectDirectory(bb, { hostId, path }),
    project_create: (input) => serial("project-create", () => serial(`project-create:${input.requestId}`, () => createWorkProject(bb, store, input))),
    bots_list: async () => {
      const warnings = await importLegacy();
      await Promise.all(store.list().map((bot) => serial(bot.id, () => state.prepare(bot.id))));
      const [hosts, projects] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.projects.list({ includePersonal: true })]);
      const personal = projects.find((project) => project.kind === "personal");
      if (!personal) throw new Error("BB's personal project is unavailable");
      personalId = personal.id;
      const bots = store.list();
      const legacyHomes = new Set(bots.map((bot) => bot.legacyHomeProjectId));
      return { bots, projectOwners: store.projectOwners().map(({ projectId, botId }) => ({ projectId, botId })), warnings: [...warnings, ...state.warnings()], personalProjectId: personalId, threadBindings: store.bindings(), sections: store.sections(), hosts: hosts.map((host) => ({ id: host.id, name: host.name, connected: host.status === "connected" })), projects: projects.filter((project) => project.kind === "standard" && !legacyHomes.has(project.id)).map((project) => ({ id: project.id, name: project.name })) };
    },
    bot_create: (input) => botService.createBot(input),
    bot_prepare: ({ botId }) => serial(botId, () => state.prepare(botId)),
    bot_update: (input) => botService.updateBot(input),
    bots_reorder: ({ bots: placements }) => serial("registry", async () => {
      const bots = store.list();
      if (placements.length !== bots.length || new Set(placements.map((entry) => entry.botId)).size !== bots.length) throw new Error("Reordering must include every bot exactly once");
      store.saveAll(placements.map(({ botId, sectionId }, order) => { botService.validateSection(sectionId); const bot = store.require(botId); return { ...bot, sectionId, order, updatedAt: nextTimestamp(bot.updatedAt) }; }));
      publish(); return { ok: true } as const;
    }),
    section_create: ({ name }) => botService.createSection(name),
    section_update: ({ sectionId, name }) => botService.renameSection(sectionId, name),
    section_delete: async ({ sectionId }) => { await botService.deleteSection(sectionId); return { ok: true } as const; },
    visibility_set: ({ botId, hiddenUntilActivity }) => botService.setVisibility(botId, hiddenUntilActivity),
    main_set: ({ botId, threadId }) => serial(botId, async () => {
      if (await resolveOwner(threadId) !== botId) throw new Error("Conversation does not belong to this bot");
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null) throw new Error("Restore this conversation before making it main");
      const latest = store.require(botId);
      const next = store.save({ ...latest, mainThreadId: threadId, updatedAt: nextTimestamp(latest.updatedAt) }); publish(); return next;
    }),
    conversation_create: (input) => botService.startConversation(input),
    conversation_fork: async ({ botId, sourceThreadId, request }) => serial(botId, async () => {
      const bot = await state.prepare(botId);
      const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
      if (source.archivedAt !== null || source.deletedAt !== null) throw new Error("The source conversation is archived or deleted.");
      if (await resolveOwner(sourceThreadId, false) !== botId) throw new Error("The source conversation does not belong to this bot.");
      if (request.environment.type !== "reuse" || !source.environmentId) throw new Error("Forks must reuse the source conversation’s environment.");
      if (request.environment.environmentId !== source.environmentId) throw new Error("The fork environment must match the source conversation.");
      if (request.projectId !== source.projectId) throw new Error("Forks must stay in the source project.");
      const thread = await bb.sdk.threads.fork({ sourceThreadId, environment: request.environment, input: request.input, permissionMode: request.permissionMode });
      store.bind(thread.id, bot.id);
      publish();
      return { threadId: thread.id };
    }),
    conversation_reorder: ({ botId, threadId, targetThreadId, position }) => serial(botId, async () => {
      const { rows } = await listBotConversations(bb, store.require(botId), resolveOwner);
      const source = rows.find(row => row.id === threadId);
      const target = rows.find(row => row.id === targetThreadId);
      if (!source || !target) throw new Error("Both conversations must be visible and belong to this bot. Refresh and try again.");
      const ids = new Set(rows.map(row => row.id));
      const parent = (row: typeof source) => row.parentThreadId && ids.has(row.parentThreadId) ? row.parentThreadId : null;
      if (parent(source) !== parent(target)) throw new Error("Reorder conversations within the same branch.");
      if (threadId !== targetThreadId) {
        const order = rows.map(row => row.id).filter(id => id !== threadId);
        order.splice(order.indexOf(targetThreadId) + Number(position === "after"), 0, threadId);
        store.mutate(botId, bot => ({ ...bot, threadOrder: order, updatedAt: nextTimestamp(bot.updatedAt) }));
        publish();
      }
      return { ok: true } as const;
    }),
    conversation_nest: ({ threadId, parentThreadId }) => serial("registry", async () => {
      if (threadId === parentThreadId) throw new Error("A conversation cannot be nested under itself.");
      const thread = await bb.sdk.threads.get({ threadId });
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null || parent.archivedAt !== null || parent.deletedAt !== null) throw new Error("Archived conversations cannot be nested.");
      const seen = new Set<string>([threadId]);
      let current: string | null = parent.parentThreadId;
      while (current) {
        if (seen.has(current)) throw new Error("That nesting would create a cycle.");
        seen.add(current);
        const ancestor = await bb.sdk.threads.get({ threadId: current });
        current = ancestor.parentThreadId;
      }
      await bb.sdk.threads.update({ threadId, parentThreadId });
      publish();
      return { ok: true } as const;
    }),
    conversation_assign: ({ botId, threadId, placeFirst }) => serial("registry", () => serial(botId, async () => {
      const bot = store.require(botId); const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt || thread.deletedAt) throw new Error("Restore this conversation before assigning it.");
      const existing = await resolveOwner(threadId, false);
      if (existing && existing !== botId) throw new Error("Conversation already belongs to another bot");
      if (store.owner(threadId) === botId) return { ok: true } as const;
      const needsLink = thread.projectId !== await personalProjectId() && thread.projectId !== bot.legacyHomeProjectId && !bot.linkedProjectIds.includes(thread.projectId);
      if (needsLink) await botService.validateLinks([thread.projectId]);
      // Membership and the new association commit together; a competing binding
      // must win without leaving an unwanted membership behind.
      // Explicit false is an outside drop at the end; omitted preserves dialog ordering.
      const appendAfter = placeFirst === false
        ? (await listBotConversations(bb, store.require(botId), resolveOwner)).rows.map(row => row.id) : undefined;
      const assigned = store.adoptInherited(threadId, botId, needsLink ? thread.projectId : null, placeFirst, appendAfter);
      if (assigned.botId !== botId) throw new Error("Conversation already belongs to another bot");
      if (assigned.joined) await state.mirror(store.require(botId));
      if (assigned.changed) publish();
      return { ok: true } as const;
    })),
    state_read: ({ botId, file }) => serial(botId, async () => state.read(await state.prepare(botId), file)),
    state_update: ({ botId, file, content, expectedSha256 }) => serial(botId, async () => { await state.prepare(botId); return state.update(botId, file, content, expectedSha256); }),
    state_apply: ({ botId, change }) => applyBotState(botId, change),
  });
}
