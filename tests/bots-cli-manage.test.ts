import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend, project, PERSONAL_ID } from "./backend-fixture";
import type { BotChangeApproval } from "../lib/bot-change-approval";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup() {
  const host = await backend([project("project"), project("other")]); hosts.push(host);
  // An agent's thread: CLI calls that carry it count as agent calls.
  host.threads.set("agent", makeThreadResponse({ id: "agent", projectId: "project" }));
  const run = (argv: string[], ctx: { threadId?: string } = {}) => host.harness.behavior.runCli(argv, ctx);
  const pending = () => host.harness.inspection.pendingInteractions;
  async function answer(approved: boolean) {
    await vi.waitFor(() => expect(pending()).toHaveLength(1));
    const [request] = pending();
    host.harness.behavior.submitInteraction(request!.id, { approved });
    return request!;
  }
  return { host, run, pending, answer };
}
const parse = (stdout: string | undefined) => JSON.parse(stdout!);

describe("bb bots create", () => {
  it("creates from a terminal without approval, with projects, ownership, section and a random look", async () => {
    const { host, run, pending } = await setup();
    const section = parse((await run(["sections", "create", "Research", "--json"])).stdout).section;
    const result = await run(["create", "Atlas", "--role", "Researcher", "--soul", "You are Atlas.", "--project", "Project other", "--own", "project", "--section", "Research", "--json"]);
    expect(result.exitCode).toBe(0);
    const { bot } = parse(result.stdout);
    expect(bot).toMatchObject({ name: "Atlas", role: "Researcher", machineId: "host-home", section: { id: section.id }, visibility: "visible", ownedProjects: [{ id: "project" }], joinedProjects: [{ id: "other" }] });
    expect(bot).not.toHaveProperty("memory"); expect(bot).not.toHaveProperty("settings");
    const saved = host.store.require(bot.id);
    expect(saved.soul).toBe("You are Atlas.");
    expect(saved.avatar.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(pending()).toHaveLength(0);
  });

  it("validates and previews with --dry-run without saving", async () => {
    const { host, run } = await setup();
    const result = await run(["create", "Atlas", "--own", "project", "--dry-run", "--json"]);
    expect(parse(result.stdout)).toMatchObject({ dryRun: true, bot: { name: "Atlas", ownedProjectIds: ["project"] } });
    expect(host.store.list()).toHaveLength(0);
  });

  it("asks the user by default when an agent creates a bot, and creates only after approval", async () => {
    const { host, run, answer } = await setup();
    const running = run(["create", "Atlas", "--soul", "Be careful.", "--own", "project", "--json"], { threadId: "agent" });
    const request = await answer(true);
    expect(request).toMatchObject({ threadId: "agent", rendererId: "bot-change-approval", title: "Create bot Atlas" });
    expect(request.payload as unknown as BotChangeApproval).toMatchObject({ kind: "create", name: "Atlas", soul: "Be careful.", projects: [{ id: "project", owner: true }], requestedBy: { threadId: "agent", botName: null } });
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(host.store.list().map((bot) => bot.name)).toEqual(["Atlas"]);
  });

  it("creates nothing when the user declines", async () => {
    const { host, run, answer } = await setup();
    const running = run(["create", "Atlas", "--json"], { threadId: "agent" });
    await answer(false);
    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(parse(result.stdout)).toMatchObject({ ok: false, error: { code: "not_approved" } });
    expect(host.store.list()).toHaveLength(0);
  });

  it("refuses agents when the setting is Off but still serves the terminal; Allow skips the form", async () => {
    const { host, run, pending } = await setup();
    await host.harness.behavior.setSettings({ agentBotChanges: "off" });
    const refused = await run(["create", "Atlas", "--json"], { threadId: "agent" });
    expect(parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "agent_bot_changes_off" } });
    expect((await run(["create", "Atlas"])).exitCode).toBe(0);
    await host.harness.behavior.setSettings({ agentBotChanges: "allow" });
    expect((await run(["create", "Beryl"], { threadId: "agent" })).exitCode).toBe(0);
    expect(pending()).toHaveLength(0);
    expect(host.store.list().map((bot) => bot.name)).toEqual(["Atlas", "Beryl"]);
  });

  it("refuses to own a project another bot owns in dry-run and before asking anyone (BBP-47)", async () => {
    const { host, run, pending } = await setup();
    const beryl = await host.create("Beryl");
    expect((await run(["projects", "own", beryl.id, "project"])).exitCode).toBe(0);
    const dryRun = await run(["create", "Atlas", "--own", "project", "--dry-run", "--json"], { threadId: "agent" });
    expect(dryRun.exitCode).toBe(1);
    expect(parse(dryRun.stdout)).toMatchObject({ ok: false, error: { code: "project_owned", message: expect.stringContaining("Beryl") } });
    const real = await run(["create", "Atlas", "--own", "project", "--json"], { threadId: "agent" });
    expect(real.exitCode).toBe(1);
    expect(parse(real.stdout)).toMatchObject({ ok: false, error: { code: "project_owned" } });
    expect(pending()).toHaveLength(0);
    expect(host.store.list().map((bot) => bot.name)).toEqual(["Beryl"]);
  });

  it("shows the approval form exactly the change that dry-run printed", async () => {
    const { host, run, answer } = await setup();
    const section = parse((await run(["sections", "create", "Research", "--json"])).stdout).section;
    const argv = ["create", "Atlas", "--role", "Researcher", "--soul", "Be careful.", "--project", "other", "--own", "project", "--section", "Research", "--hidden", "--json"];
    const { bot: dryRun } = parse((await run([...argv, "--dry-run"], { threadId: "agent" })).stdout);
    expect(dryRun).toEqual({
      kind: "create", name: "Atlas", role: "Researcher", soul: "Be careful.", sectionId: section.id, section: "Research", hidden: true,
      linkedProjectIds: ["other", "project"], ownedProjectIds: ["project"],
      projects: [{ id: "other", name: "Project other", owner: false }, { id: "project", name: "Project project", owner: true }],
    });
    const running = run(argv, { threadId: "agent" });
    const request = await answer(true);
    expect(request.payload).toEqual({ ...dryRun, requestedBy: { threadId: "agent", botName: null } });
    expect((await running).exitCode).toBe(0);
    expect(host.store.list()[0]).toMatchObject({ name: "Atlas", hiddenUntilActivity: true, sectionId: section.id });
  });

  it("rejects invalid input before asking anyone", async () => {
    const { host, run, pending } = await setup();
    for (const argv of [["create", " "], ["create", "x".repeat(121)], ["create", "Atlas", "--soul", "x".repeat(4097)], ["create", "Atlas", "--project", "missing"], ["create", "Atlas", "--section", "missing"], ["create", "Atlas", "--machine", "missing"]]) {
      expect((await run(argv, { threadId: "agent" })).exitCode).toBe(1);
    }
    expect(pending()).toHaveLength(0);
    expect(host.store.list()).toHaveLength(0);
  });
});

describe("bb bots update and show", () => {
  it("shows identity and instructions but never memory or settings", async () => {
    const { host, run } = await setup();
    const atlas = await host.create("Atlas");
    const { bot } = parse((await run(["show", "Atlas", "--json"])).stdout);
    expect(bot).toMatchObject({ id: atlas.id, name: "Atlas", soul: "You are Atlas." });
    expect(bot).not.toHaveProperty("memory"); expect(bot).not.toHaveProperty("settings");
  });

  it("asks before an agent changes identity, but not for visibility alone", async () => {
    const { host, run, answer, pending } = await setup();
    const atlas = await host.create("Atlas");
    const running = run(["update", atlas.id, "--role", "Editor", "--soul", "New voice.", "--json"], { threadId: "agent" });
    const request = await answer(true);
    expect(request.payload as unknown as BotChangeApproval).toMatchObject({ kind: "update", role: "Editor", soul: "New voice.", previous: { name: "Atlas", role: "Research", soul: "You are Atlas." } });
    expect((await running).exitCode).toBe(0);
    expect(host.store.require(atlas.id)).toMatchObject({ role: "Editor", soul: "New voice." });
    expect((await run(["update", atlas.id, "--visibility", "hidden"], { threadId: "agent" })).exitCode).toBe(0);
    expect(host.store.require(atlas.id).hiddenUntilActivity).toBe(true);
    expect(pending()).toHaveLength(0);
  });

  it("fails instead of overwriting an edit made while approval was pending", async () => {
    const { host, run, pending } = await setup();
    const atlas = await host.create("Atlas");
    const running = run(["update", atlas.id, "--role", "Editor", "--json"], { threadId: "agent" });
    await vi.waitFor(() => expect(pending()).toHaveLength(1));
    const latest = host.store.require(atlas.id);
    await host.harness.behavior.callRpc("bot_update", { name: "Atlas", role: "Changed in the sidebar", soul: latest.soul, avatar: latest.avatar, sectionId: null, linkedProjectIds: latest.linkedProjectIds, botId: atlas.id, expectedUpdatedAt: latest.updatedAt, expectedStateHashes: latest.stateHashes });
    host.harness.behavior.submitInteraction(pending()[0]!.id, { approved: true });
    expect((await running).exitCode).toBe(1);
    expect(host.store.require(atlas.id).role).toBe("Changed in the sidebar");
  });

  it("requires at least one change", async () => {
    const { host, run } = await setup();
    const atlas = await host.create("Atlas");
    expect((await run(["update", atlas.id])).exitCode).toBe(1);
  });
});

describe("bb bots projects, sections and chat", () => {
  it("changes project roles and refuses a second owner", async () => {
    const { host, run } = await setup();
    const atlas = await host.create("Atlas", []), beryl = await host.create("Beryl", []);
    expect(parse((await run(["projects", "own", "Atlas", "project", "--json"])).stdout)).toMatchObject({ changed: true, bot: { ownedProjects: [{ id: "project" }] } });
    expect((await run(["projects", "own", beryl.id, "project"])).exitCode).toBe(1);
    expect(parse((await run(["projects", "release", atlas.id, "project", "--json"])).stdout)).toMatchObject({ bot: { ownedProjects: [], joinedProjects: [{ id: "project" }] } });
    expect(parse((await run(["projects", "leave", atlas.id, "project", "--json"])).stdout)).toMatchObject({ bot: { joinedProjects: [] } });
    expect((await run(["projects", "leave", atlas.id, "project"])).exitCode).toBe(1);
  });

  it("refuses ambiguous names and asks for an ID", async () => {
    const { host, run } = await setup();
    await host.create("Atlas"); await host.create("Atlas");
    const result = await run(["show", "Atlas", "--json"]);
    expect(parse(result.stdout)).toMatchObject({ ok: false, error: { code: "ambiguous_bot" } });
  });

  it("creates, renames and deletes sections, moving bots back to Main and protecting Main", async () => {
    const { host, run } = await setup();
    const atlas = await host.create("Atlas");
    await run(["sections", "create", "Team"]);
    await run(["update", atlas.id, "--section", "Team"]);
    expect((await run(["sections", "rename", "Team", "Crew"])).exitCode).toBe(0);
    expect(parse((await run(["sections", "list", "--json"])).stdout)).toMatchObject({ sections: [{ name: "Crew", botCount: 1 }], mainBotCount: 0 });
    expect((await run(["sections", "delete", "main"])).exitCode).toBe(1);
    expect((await run(["sections", "delete", "Crew"])).exitCode).toBe(0);
    expect(host.store.require(atlas.id).sectionId).toBeNull();
  });

  it("starts a conversation in the bot's owned project, or with no project when it owns none", async () => {
    const { host, run } = await setup();
    const atlas = await host.create("Atlas", []);
    const personal = parse((await run(["chat", "Atlas", "Hello", "--json"])).stdout);
    expect(personal).toMatchObject({ botId: atlas.id, projectId: PERSONAL_ID });
    expect(host.store.owner(personal.threadId)).toBe(atlas.id);
    await run(["projects", "own", atlas.id, "project"]);
    const owned = parse((await run(["chat", atlas.id, "Plan the work", "--json"])).stdout);
    expect(owned.projectId).toBe("project");
    expect(host.store.owner(owned.threadId)).toBe(atlas.id);
    expect((await run(["chat", atlas.id, " "])).exitCode).toBe(1);
  });
});
