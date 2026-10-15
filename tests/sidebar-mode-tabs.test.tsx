// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { bot, personalProjectId, sidebarProject, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
let body: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  // Stand-in for BB's sidebar shell: the body holds the thread-list content.
  body = document.createElement("div");
  body.dataset.testid = "app-sidebar-body";
  body.innerHTML = `<div data-sidebar="content">Thread list</div>`;
  document.body.append(body);
});
afterEach(() => { cleanup(); body.remove(); });

function mountTabs(initial: string) {
  let provider = initial;
  const set = vi.fn((input: unknown) => {
    provider = (input as { mode: string }).mode === "bots" ? "bots-sidebar/bot-projects" : "thread-list/thread-list";
    return { provider };
  });
  const slot = renderSlot(app.appOverlays[0]!, {}, { rpc: { sidebar_mode_get: () => ({ provider }), sidebar_mode_set: set } });
  return { slot, set };
}
const tablist = () => within(body).getByRole("tablist", { name: "Sidebar view" });

it("registers the Code / Bots tabs as an app overlay", () => {
  expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["sidebar-mode-tabs"]);
});

it("renders directly above the sidebar's thread-list area and marks the active provider", async () => {
  mountTabs("thread-list/thread-list");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  const host = body.querySelector("[data-bots-sidebar-mode-tabs]")!;
  expect(host.nextElementSibling?.getAttribute("data-sidebar")).toBe("content");
  expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("false");
});

it("pins the matching provider when a tab is chosen", async () => {
  const { set } = mountTabs("thread-list/thread-list");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  fireEvent.click(within(tablist()).getByRole("tab", { name: "Bots" }));
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
  expect(set).toHaveBeenCalledWith({ mode: "bots" });
  fireEvent.click(within(tablist()).getByRole("tab", { name: "Bots" }));
  expect(set).toHaveBeenCalledTimes(1);
});

it("switches tabs with the arrow keys", async () => {
  const { set } = mountTabs("bots-sidebar/bot-projects");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
  fireEvent.keyDown(within(tablist()).getByRole("tab", { name: "Bots" }), { key: "ArrowLeft" });
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  expect(set).toHaveBeenCalledWith({ mode: "code" });
});

it("infers the active tab from the rendered list under BB's automatic choice", async () => {
  body.innerHTML = `<div data-sidebar="content"><div class="bots-sidebar">Bots</div></div>`;
  mountTabs("__automatic__");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
});

it("re-reads the provider when BB swaps the list, e.g. from Settings → Appearance", async () => {
  let provider = "bots-sidebar/bot-projects";
  const get = vi.fn(() => ({ provider }));
  renderSlot(app.appOverlays[0]!, {}, { rpc: { sidebar_mode_get: get, sidebar_mode_set: () => ({ provider }) } });
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
  provider = "cursor-sidebar/cursor";
  body.querySelector('[data-sidebar="content"]')!.innerHTML = "<div>Cursor list</div>";
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  expect(get.mock.calls.length).toBeGreaterThan(1);
});

it("follows a list swap under BB's automatic choice without a provider change", async () => {
  body.innerHTML = `<div data-sidebar="content"><div>BB list</div></div>`;
  mountTabs("__automatic__");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  body.querySelector('[data-sidebar="content"]')!.innerHTML = `<div class="bots-sidebar">Bots</div>`;
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
});

it("ignores a slow refresh that settles after a newer tab choice", async () => {
  let releaseRefresh!: (value: { provider: string }) => void;
  let gets = 0;
  const get = vi.fn(() => ++gets === 1 ? { provider: "thread-list/thread-list" } : new Promise<{ provider: string }>((resolve) => { releaseRefresh = resolve; }));
  renderSlot(app.appOverlays[0]!, {}, { rpc: { sidebar_mode_get: get, sidebar_mode_set: () => ({ provider: "bots-sidebar/bot-projects" }) } });
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  fireEvent.click(within(tablist()).getByRole("tab", { name: "Bots" }));
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
  releaseRefresh({ provider: "thread-list/thread-list" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps focus on the tab after an arrow-key switch swaps the list", async () => {
  mountTabs("thread-list/thread-list");
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
  within(tablist()).getByRole("tab", { name: "Code" }).focus();
  fireEvent.keyDown(within(tablist()).getByRole("tab", { name: "Code" }), { key: "ArrowRight" });
  body.querySelector('[data-sidebar="content"]')!.innerHTML = `<div class="bots-sidebar">Bots</div>`;
  await waitFor(() => expect(within(tablist()).getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  expect(document.activeElement?.textContent).toBe("Bots");
});

it("re-anchors when the sidebar re-renders its content", async () => {
  mountTabs("thread-list/thread-list");
  await waitFor(() => tablist());
  body.innerHTML = `<div data-sidebar="content">Replaced list</div>`;
  await waitFor(() => expect(body.querySelector("[data-bots-sidebar-mode-tabs]")?.nextElementSibling?.textContent).toBe("Replaced list"));
});

it("shows only bots by default and opts into unassigned chats from the + menu", async () => {
  const slot = renderSlot(app.threadLists[0]!, {
    activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "",
  }, {
    sidebarThreads: {
      projects: [sidebarProject("project", "Project"), sidebarProject("personal", "Personal", true)],
      threads: [thread("main", 1000), thread("chat", 200, { projectId: "personal", environment: null })],
    },
    rpc: { bots_list: () => ({ personalProjectId, bots: [bot], hosts: [{ id: "host", name: "Local", connected: true }], sections: [], projects: [{ id: "project", name: "Project" }], threadBindings: [{ threadId: "main", botId: bot.id }], warnings: [] }) },
  });
  await slot.findByText("Test bot");
  expect(slot.queryByText("Conversation chat")).toBeNull();
  fireEvent.keyDown(slot.getByRole("button", { name: "Create…" }), { key: "ArrowDown" });
  fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: "Show unassigned chats" }));
  expect(await slot.findByText("Conversation chat")).toBeTruthy();
  expect(localStorage.getItem("bots:show-chats")).toBe("true");
});
