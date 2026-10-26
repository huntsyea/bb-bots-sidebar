import { afterEach, describe, expect, it } from "vitest";
import { avatar, backend, PERSONAL_ID, project } from "./backend-fixture";
import { createBotService, type BotChange } from "../lib/bot-service";
import { createPrivateBotState } from "../lib/private-state";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

// The bot write module over the fixture's fake BB host and a real store.
async function setup() {
  const host = await backend([project("project"), project("other")]); hosts.push(host);
  const store = host.store;
  const service = createBotService({
    bb: host.bb, store, state: createPrivateBotState(host.bb, store, () => {}), publish: () => {},
    importLegacy: async () => [], serial: (_key, operation) => operation(), personalProjectId: async () => PERSONAL_ID,
  });
  const create = (name: string, fields: Partial<Extract<BotChange, { kind: "create" }>> = {}) =>
    service.applyBotChange({ kind: "create", name, hostId: "host-home", avatar, ...fields });
  return { host, store, service, create };
}

describe("the bot write module", () => {
  it("checks a whole change, ownership conflicts included, without writing", async () => {
    const { store, service, create } = await setup();
    const { bot: beryl } = await create("Beryl", { linkedProjectIds: ["project"], ownedProjectIds: ["project"] });
    const proposal: BotChange = { kind: "create", name: " Atlas ", hostId: "host-home", avatar, linkedProjectIds: ["project", "other"], ownedProjectIds: ["project"] };
    await expect(service.checkBotChange(proposal)).rejects.toMatchObject({ code: "project_owned", message: expect.stringContaining("Beryl") });
    const checked = await service.checkBotChange({ ...proposal, ownedProjectIds: ["other"] });
    expect(checked).toMatchObject({ botId: null, summary: { kind: "create", name: "Atlas", ownedProjectIds: ["other"], projects: [{ id: "project", owner: false }, { id: "other", owner: true }] } });
    expect(store.list().map((bot) => bot.id)).toEqual([beryl.id]);
  });

  it("fails a confirmed change if another bot took the project while it waited", async () => {
    const { store, service, create } = await setup();
    const { bot: beryl } = await create("Beryl", { linkedProjectIds: ["project"] });
    const confirmed: string[] = [];
    await expect(service.applyBotChange({ kind: "create", name: "Atlas", hostId: "host-home", avatar, linkedProjectIds: ["project"], ownedProjectIds: ["project"] }, {
      confirm: async (checked) => { confirmed.push(checked.summary.name); await service.changeProjectRole(beryl.id, "own", "project"); },
    })).rejects.toMatchObject({ code: "project_owned" });
    expect(confirmed).toEqual(["Atlas"]);
    expect(store.list().map((bot) => bot.name)).toEqual(["Beryl"]);
  });

  it("updates only the named fields against one revision", async () => {
    const { store, service, create } = await setup();
    const { bot } = await create("Atlas", { role: "Research", soul: "You are Atlas.", sectionId: null });
    const { checked, bot: edited } = await service.applyBotChange({ kind: "update", botId: bot.id, revision: bot.updatedAt, role: "Editor", hidden: true });
    expect(checked.changed).toEqual(["role", "hidden"]);
    expect(edited).toMatchObject({ name: "Atlas", role: "Editor", soul: "You are Atlas.", hiddenUntilActivity: true, hiddenAt: expect.any(Number) });
    await expect(service.applyBotChange({ kind: "update", botId: bot.id, revision: bot.updatedAt, name: "Stale" })).rejects.toMatchObject({ code: "bot_changed" });
    expect(store.require(bot.id).name).toBe("Atlas");
  });

  it("writes nothing for an update that changes nothing", async () => {
    const { store, service, create } = await setup();
    const { bot } = await create("Atlas", { role: "Research" });
    const result = await service.applyBotChange({ kind: "update", botId: bot.id, revision: bot.updatedAt, name: "Atlas", role: "Research" });
    expect(result.checked.changed).toEqual([]);
    expect(store.require(bot.id).updatedAt).toBe(bot.updatedAt);
  });
});
