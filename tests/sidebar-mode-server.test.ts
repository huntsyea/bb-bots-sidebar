import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { modeForProvider, providerForMode, rememberedCodeProvider } from "../lib/sidebar-mode";

describe("sidebar mode rules", () => {
  it("treats every list other than ours as Code, and automatic as unknown", () => {
    expect(modeForProvider("thread-list/thread-list")).toBe("code");
    expect(modeForProvider("cursor-sidebar/cursor")).toBe("code");
    expect(modeForProvider("bots-sidebar/bot-projects")).toBe("bots");
    expect(modeForProvider("__automatic__")).toBeNull();
    expect(modeForProvider(null)).toBeNull();
  });
  it("remembers only concrete non-Bots lists for the Code tab", () => {
    expect(rememberedCodeProvider(null, "cursor-sidebar/cursor")).toBe("cursor-sidebar/cursor");
    expect(rememberedCodeProvider("cursor-sidebar/cursor", "bots-sidebar/bot-projects")).toBe("cursor-sidebar/cursor");
    expect(rememberedCodeProvider("cursor-sidebar/cursor", "__automatic__")).toBe("cursor-sidebar/cursor");
    expect(rememberedCodeProvider(null, "__automatic__")).toBeNull();
  });
  it("falls back to BB's own list until a Code list is known", () => {
    expect(providerForMode("code", null)).toBe("thread-list/thread-list");
    expect(providerForMode("code", "cursor-sidebar/cursor")).toBe("cursor-sidebar/cursor");
    expect(providerForMode("bots", "cursor-sidebar/cursor")).toBe("bots-sidebar/bot-projects");
  });
});

describe("sidebar mode RPC", () => {
  async function setup(initial: string) {
    const preference = { value: initial, revision: 1 };
    const host = createFakePluginHost({ pluginId: "bots-sidebar", sdk: { system: { uiPreferences: {
      list: async () => ({ preferences: { "sidebar.threadListProvider": { ...preference } } }),
      set: async ({ key, value, expectedRevision }: { key: string; value: string; expectedRevision: number }) => {
        if (expectedRevision !== preference.revision) throw new Error("stale revision");
        preference.value = value; preference.revision += 1;
        return { key, value, revision: preference.revision };
      },
    } } } as never });
    await plugin(host.bb);
    // Stands in for the user picking a list in Settings → Appearance.
    const appearance = (value: string) => { preference.value = value; preference.revision += 1; };
    const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<{ provider: string }>;
    return { call, appearance };
  }

  it("returns to the Appearance list after Bots", async () => {
    const { call } = await setup("cursor-sidebar/cursor");
    expect(await call("sidebar_mode_set", { mode: "bots" })).toEqual({ provider: "bots-sidebar/bot-projects" });
    expect(await call("sidebar_mode_set", { mode: "code" })).toEqual({ provider: "cursor-sidebar/cursor" });
  });

  it("picks up a new Appearance choice when it is read", async () => {
    const { call, appearance } = await setup("thread-list/thread-list");
    await call("sidebar_mode_set", { mode: "bots" });
    appearance("cursor-sidebar/cursor");
    expect(await call("sidebar_mode_get", null)).toEqual({ provider: "cursor-sidebar/cursor" });
    await call("sidebar_mode_set", { mode: "bots" });
    expect(await call("sidebar_mode_set", { mode: "code" })).toEqual({ provider: "cursor-sidebar/cursor" });
  });

  it("uses BB's own list for Code when only automatic or Bots was ever seen", async () => {
    const { call } = await setup("__automatic__");
    await call("sidebar_mode_set", { mode: "bots" });
    expect(await call("sidebar_mode_set", { mode: "code" })).toEqual({ provider: "thread-list/thread-list" });
  });
});
