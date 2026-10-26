import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend, project, PERSONAL_ID, request } from "./backend-fixture";
import { readBotExport } from "../lib/bot-export";
import type { BotChangeApproval } from "../lib/bot-change-approval";
import type { BotMetadata } from "../contract";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup() {
  const host = await backend([project("project"), project("other")]); hosts.push(host);
  host.threads.set("agent", makeThreadResponse({ id: "agent", projectId: "project" }));
  const run = (argv: string[], ctx: { threadId?: string } = {}) => host.harness.behavior.runCli(argv, ctx);
  const pending = () => host.harness.inspection.pendingInteractions;
  async function answer(approved: boolean) {
    await vi.waitFor(() => expect(pending()).toHaveLength(1));
    const [interaction] = pending();
    host.harness.behavior.submitInteraction(interaction!.id, { approved });
    return interaction!;
  }
  const rpc = <T>(method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<T>;
  // A bot with real private state and two bound conversations, one with an inheriting child.
  async function seeded(name: string, projects: string[] = ["project"]) {
    const bot = await host.create(name, projects);
    const edited = await rpc<BotMetadata>("bot_update", {
      botId: bot.id, name, role: bot.role, avatar: bot.avatar, sectionId: null, linkedProjectIds: bot.linkedProjectIds, soul: `You are ${name}.\nBe brief.`,
      memory: `- ${name} prefers short answers.\n`, settings: { tone: "plain", depth: 2 }, launchPreset: { execution: null, workspace: "worktree", initialPrompt: "Start here." },
      expectedUpdatedAt: bot.updatedAt, expectedStateHashes: bot.stateHashes,
    });
    const first = await rpc<{ threadId: string }>("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) });
    const second = await rpc<{ threadId: string }>("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) });
    host.threads.set(`${first.threadId}-child`, makeThreadResponse({ id: `${first.threadId}-child`, projectId: PERSONAL_ID, parentThreadId: first.threadId }));
    return { bot: host.store.require(edited.id), threads: [first.threadId, second.threadId] };
  }
  const exportsDir = () => join(dirname(host.store.databasePath), "state", "_deleted-bots");
  return { host, run, pending, answer, rpc, seeded, exportsDir };
}
const parse = (stdout: string | undefined) => JSON.parse(stdout!);

describe("bb bots delete blockers", () => {
  it("refuses while the bot owns a project, naming it, in dry-run and before asking anyone", async () => {
    const { host, run, pending, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    expect((await run(["projects", "own", bot.id, "project"])).exitCode).toBe(0);
    const dryRun = await run(["delete", bot.id, "--dry-run", "--json"], { threadId: "agent" });
    expect(dryRun.exitCode).toBe(1);
    expect(parse(dryRun.stdout)).toMatchObject({
      dryRun: true, deletable: false, bot: { kind: "delete", name: "Atlas" },
      blockers: [{ code: "project_owned", message: expect.stringMatching(/Project project[\s\S]*bb bots projects release/) }],
    });
    const real = await run(["delete", bot.id, "--json"], { threadId: "agent" });
    expect(parse(real.stdout)).toMatchObject({ ok: false, error: { code: "project_owned" } });
    expect(pending()).toHaveLength(0);
    expect(host.store.get(bot.id)).not.toBeNull();
  });

  it("refuses while a change approval is pending for that bot", async () => {
    const { host, run, pending, rpc, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    const update = run(["update", bot.id, "--role", "Editor"], { threadId: "agent" });
    await vi.waitFor(() => expect(pending()).toHaveLength(1));
    expect(parse((await run(["delete", bot.id, "--dry-run", "--json"])).stdout)).toMatchObject({ deletable: false, blockers: [{ code: "approval_pending" }] });
    await expect(rpc("bot_delete", { botId: bot.id, expectedUpdatedAt: bot.updatedAt })).rejects.toThrow(/approval is pending/);
    expect(host.store.get(bot.id)).not.toBeNull();
    host.harness.behavior.submitInteraction(pending()[0]!.id, { approved: false });
    await update;
    expect((await run(["delete", bot.id, "--json"])).exitCode).toBe(0);
  });
});

describe("deleting a bot", () => {
  it("writes an export before deleting, which reads back into the bot's full content", async () => {
    const { host, run, seeded, exportsDir } = await setup();
    const { bot, threads } = await seeded("Atlas");
    const result = await run(["delete", bot.id, "--json"]);
    expect(result.exitCode).toBe(0);
    const { exportPath, deleted } = parse(result.stdout);
    expect(deleted).toMatchObject({ id: bot.id, name: "Atlas" });
    expect(dirname(exportPath)).toBe(exportsDir());
    const restored = readBotExport(readFileSync(exportPath, "utf8"));
    expect(restored.bot).toEqual(bot);
    expect(restored.bot).toMatchObject({ soul: "You are Atlas.\nBe brief.", memory: "- Atlas prefers short answers.\n", settings: { tone: "plain", depth: 2 }, launchPreset: { initialPrompt: "Start here." } });
    expect(restored.bindings.sort()).toEqual([...threads].sort());
    expect(host.store.get(bot.id)).toBeNull();
  });

  it("deletes nothing when the export cannot be written", async () => {
    const { host, run, seeded, exportsDir } = await setup();
    const { bot } = await seeded("Atlas");
    mkdirSync(dirname(exportsDir()), { recursive: true });
    writeFileSync(exportsDir(), "not a directory");
    const result = await run(["delete", bot.id, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(host.store.require(bot.id)).toEqual(bot);
    expect(host.store.bindings().filter((binding) => binding.botId === bot.id)).toHaveLength(2);
  });

  it("keeps its conversations as ordinary threads", async () => {
    const { host, run, seeded } = await setup();
    const { bot, threads } = await seeded("Atlas");
    expect((await run(["delete", bot.id])).exitCode).toBe(0);
    for (const threadId of [...threads, `${threads[0]}-child`]) {
      expect(host.threads.get(threadId)).toBeDefined();
      expect(host.store.owner(threadId)).toBeNull();
      const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: PERSONAL_ID, kind: "personal" } }));
      expect(config.tools).toEqual([]);
    }
    expect(host.store.bindings()).toEqual([]);
  });

  it("leaves every other bot's state, bindings and project owners untouched", async () => {
    const { host, run, seeded } = await setup();
    const { bot } = await seeded("Atlas", ["other"]);
    const { bot: beryl } = await seeded("Beryl");
    const cyra = await host.create("Cyra", ["other"]);
    expect((await run(["projects", "own", beryl.id, "project"])).exitCode).toBe(0);
    const others = () => ({
      bots: [beryl.id, cyra.id].map((id) => host.store.require(id)),
      bindings: host.store.bindings().filter((binding) => binding.botId !== bot.id),
      owners: host.store.projectOwners(),
    });
    const before = others();
    expect((await run(["delete", bot.id])).exitCode).toBe(0);
    expect(others()).toEqual(before);
    expect(host.store.list().map((entry) => entry.name)).toEqual(["Beryl", "Cyra"]);
  });
});

describe("who may delete", () => {
  it("always asks the user for an agent's delete, even with Allow, and shows what dry-run showed", async () => {
    const { host, run, answer, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    await host.harness.behavior.setSettings({ agentBotChanges: "allow" });
    const { bot: dryRun } = parse((await run(["delete", bot.id, "--dry-run", "--json"], { threadId: "agent" })).stdout);
    expect(dryRun).toMatchObject({ kind: "delete", name: "Atlas", removal: { memoryCharacters: 31, settingsKeys: ["depth", "tone"], conversationCount: 2 } });
    const declined = run(["delete", bot.id, "--json"], { threadId: "agent" });
    const interaction = await answer(false);
    expect(interaction).toMatchObject({ rendererId: "bot-change-approval", title: "Delete bot Atlas" });
    expect(interaction.payload as unknown as BotChangeApproval).toEqual({ ...dryRun, requestedBy: { threadId: "agent", botName: null } });
    expect(parse((await declined).stdout)).toMatchObject({ ok: false, error: { code: "not_approved" } });
    expect(host.store.get(bot.id)).not.toBeNull();
    const approved = run(["delete", bot.id, "--json"], { threadId: "agent" });
    await answer(true);
    expect((await approved).exitCode).toBe(0);
    expect(host.store.get(bot.id)).toBeNull();
  });

  it("refuses agents when the setting is Off; a terminal deletes without a form", async () => {
    const { host, run, pending, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    await host.harness.behavior.setSettings({ agentBotChanges: "off" });
    expect(parse((await run(["delete", bot.id, "--json"], { threadId: "agent" })).stdout)).toMatchObject({ ok: false, error: { code: "agent_bot_changes_off" } });
    expect((await run(["delete", bot.id])).exitCode).toBe(0);
    expect(pending()).toHaveLength(0);
    expect(host.store.get(bot.id)).toBeNull();
  });

  it("lets the sidebar check, then delete, with the same checked change", async () => {
    const { host, rpc, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    const preview = await rpc<{ summary: unknown; blockers: unknown[]; exportPath: null }>("bot_delete", { botId: bot.id, expectedUpdatedAt: bot.updatedAt, dryRun: true });
    expect(preview).toMatchObject({ blockers: [], exportPath: null, summary: { kind: "delete", name: "Atlas", removal: { conversationCount: 2 } } });
    expect(host.store.get(bot.id)).not.toBeNull();
    const done = await rpc<{ summary: unknown; exportPath: string }>("bot_delete", { botId: bot.id, expectedUpdatedAt: bot.updatedAt });
    expect(done.summary).toEqual(preview.summary);
    expect(readBotExport(readFileSync(done.exportPath, "utf8")).bot.id).toBe(bot.id);
    expect(host.store.get(bot.id)).toBeNull();
  });

  it("fails a delete if the bot changed since it was read", async () => {
    const { host, rpc, seeded } = await setup();
    const { bot } = await seeded("Atlas");
    await rpc("visibility_set", { botId: bot.id, hiddenUntilActivity: true });
    await expect(rpc("bot_delete", { botId: bot.id, expectedUpdatedAt: bot.updatedAt })).rejects.toThrow(/changed/);
    expect(host.store.get(bot.id)).not.toBeNull();
  });
});
