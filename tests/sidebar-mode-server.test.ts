import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createSidebarMode, modeForProvider } from "../lib/sidebar-mode";

describe("sidebar mode rules", () => {
  it("treats every list other than ours as Threads, and automatic as unknown", () => {
    expect(modeForProvider("thread-list/thread-list")).toBe("threads");
    expect(modeForProvider("cursor-sidebar/cursor")).toBe("threads");
    expect(modeForProvider("bots-sidebar/bot-projects")).toBe("bots");
    expect(modeForProvider("__automatic__")).toBeNull();
    expect(modeForProvider(null)).toBeNull();
  });
});

function fakeHost(initial: string) {
  const preference = { value: initial, revision: 1 };
  const reads: (() => void)[] = [];
  const host = createFakePluginHost({ pluginId: "bots-sidebar", sdk: { system: { uiPreferences: {
    list: async () => { const read = { preferences: { "sidebar.threadListProvider": { ...preference } } }; reads.shift()?.(); return read; },
    set: async ({ key, value, expectedRevision }: { key: string; value: string; expectedRevision: number }) => {
      if (expectedRevision !== preference.revision) throw new Error("stale revision");
      preference.value = value; preference.revision += 1;
      return { key, value, revision: preference.revision };
    },
  } } } as never });
  // Stands in for the user picking a list in Settings → Appearance.
  const appearance = (value: string) => { preference.value = value; preference.revision += 1; };
  /** Runs `change` just after the next read returns, as a racing writer would. */
  const afterNextRead = (change: () => void) => { reads.push(change); };
  return { host, preference, appearance, afterNextRead };
}

describe("the sidebar mode module", () => {
  it("returns to the Appearance list after Bots", async () => {
    const { host } = fakeHost("cursor-sidebar/cursor");
    const mode = createSidebarMode(host.bb);
    expect(await mode.set("bots")).toEqual({ provider: "bots-sidebar/bot-projects" });
    expect(await mode.set("threads")).toEqual({ provider: "cursor-sidebar/cursor" });
  });

  it("picks up a new Appearance choice when it is read", async () => {
    const { host, appearance } = fakeHost("thread-list/thread-list");
    const mode = createSidebarMode(host.bb);
    await mode.set("bots");
    appearance("cursor-sidebar/cursor");
    expect(await mode.get()).toEqual({ provider: "cursor-sidebar/cursor" });
    await mode.set("bots");
    expect(await mode.set("threads")).toEqual({ provider: "cursor-sidebar/cursor" });
  });

  it("uses BB's own list for Threads when only automatic or Bots was ever seen", async () => {
    const { host } = fakeHost("__automatic__");
    const mode = createSidebarMode(host.bb);
    await mode.set("bots");
    expect(await mode.set("threads")).toEqual({ provider: "thread-list/thread-list" });
  });

  it("remembers the Threads list under the sidebar:code-provider key, across reloads", async () => {
    const { host } = fakeHost("cursor-sidebar/cursor");
    await createSidebarMode(host.bb).get();
    expect(await host.bb.storage.kv.get("sidebar:code-provider")).toBe("cursor-sidebar/cursor");
    const reloaded = createSidebarMode(host.bb);
    await reloaded.set("bots");
    expect(await reloaded.set("threads")).toEqual({ provider: "cursor-sidebar/cursor" });
  });

  it("refuses a write over a preference changed since it was read", async () => {
    const { host, preference, appearance, afterNextRead } = fakeHost("thread-list/thread-list");
    afterNextRead(() => appearance("thread-list/thread-list"));
    await expect(createSidebarMode(host.bb).set("bots")).rejects.toThrow(/stale revision/);
    expect(preference.value).toBe("thread-list/thread-list");
  });
});

describe("sidebar mode RPC", () => {
  it("serves the tabs through the plugin's sidebar_mode_get and sidebar_mode_set", async () => {
    const { host } = fakeHost("cursor-sidebar/cursor");
    await plugin(host.bb);
    const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<{ provider: string }>;
    expect(await call("sidebar_mode_get", null)).toEqual({ provider: "cursor-sidebar/cursor" });
    expect(await call("sidebar_mode_set", { mode: "bots" })).toEqual({ provider: "bots-sidebar/bot-projects" });
    expect(await call("sidebar_mode_set", { mode: "threads" })).toEqual({ provider: "cursor-sidebar/cursor" });
  });
});
