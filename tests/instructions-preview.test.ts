import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { backend, project, PERSONAL_ID, request } from "./backend-fixture";
import type { BotMetadata } from "../contract";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

type Preview = { botId: string; projectId: string; mode: string; instructions: string; characters: number };

async function setup() {
  const host = await backend([project("project"), project("other")]); hosts.push(host);
  const rpc = <T>(method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<T>;
  const atlas = await host.create("Atlas", ["project"]);
  const beryl = await host.create("Beryl", ["project"]);
  await host.harness.behavior.runCli(["projects", "own", atlas.id, "project"]);
  // Memory and a long SOUL, so the preview has to reproduce the real excerpting.
  const latest = host.store.require(atlas.id);
  await rpc<BotMetadata>("bot_update", { botId: atlas.id, name: latest.name, role: latest.role, avatar: latest.avatar, sectionId: null, linkedProjectIds: latest.linkedProjectIds, soul: "Be exact. ".repeat(200), memory: "- Prefers short answers.\n", expectedUpdatedAt: latest.updatedAt, expectedStateHashes: latest.stateHashes });
  // What the dispatch path injects for a conversation of `botId` in `projectId`.
  async function injected(botId: string, projectId: string) {
    const { threadId } = await rpc<{ threadId: string }>("conversation_create", { botId, request: request(PERSONAL_ID) });
    const projects = await host.bb.sdk.projects.list({ includePersonal: true });
    const target = projects.find((entry) => entry.id === projectId)!;
    const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: target.id, kind: target.kind, name: target.name, gitRemoteUrl: null } }));
    return config.instructions;
  }
  return { host, rpc, atlas, beryl, injected };
}

it("returns exactly what the dispatch path injects, for owner, member, unjoined and personal modes", async () => {
  const { rpc, atlas, beryl, injected } = await setup();
  for (const [botId, projectId, mode] of [[atlas.id, "project", "owner"], [beryl.id, "project", "member"], [beryl.id, "other", "unjoined"], [atlas.id, PERSONAL_ID, "personal"]] as const) {
    const preview = await rpc<Preview>("instructions_preview", { botId, projectId });
    const expected = await injected(botId, projectId);
    expect(preview).toEqual({ botId, projectId, mode, instructions: expected, characters: expected!.length });
  }
  const owner = await rpc<Preview>("instructions_preview", { botId: atlas.id, projectId: "project" });
  expect(owner.instructions).toContain("You are the owner of this project");
  expect(owner.instructions).toContain("[Truncated: use bot_read_state for complete state.]");
  expect(owner.instructions).toContain("- Prefers short answers.");
});

it("writes nothing", async () => {
  const { host, rpc, atlas } = await setup();
  const before = { bots: host.store.list(), bindings: host.store.bindings(), owners: host.store.projectOwners() };
  await rpc("instructions_preview", { botId: atlas.id, projectId: "project" });
  expect({ bots: host.store.list(), bindings: host.store.bindings(), owners: host.store.projectOwners() }).toEqual(before);
});

it("gives clean errors for an unknown bot or project", async () => {
  const { rpc, atlas } = await setup();
  await expect(rpc("instructions_preview", { botId: "bot_missing", projectId: "project" })).rejects.toThrow(/^Bot not found: bot_missing$/);
  await expect(rpc("instructions_preview", { botId: atlas.id, projectId: "proj_missing" })).rejects.toThrow(/^Project not found: proj_missing$/);
});
