// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";
import { BotChangeApprovalForm } from "../components/bot-change-approval";
import type { BotChangeApproval, BotChangeBlocker, BotChangeSummary } from "../lib/bot-change-approval";

const app = await loadPluginApp(() => import("../app"));
afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); });

const summary: BotChangeSummary = {
  kind: "delete", name: bot.name, role: bot.role, soul: bot.soul, sectionId: null, section: null, linkedProjectIds: [], ownedProjectIds: [], projects: [], hidden: false,
  previous: { name: bot.name, role: bot.role, soul: bot.soul },
  removal: { memoryCharacters: 42, settingsKeys: ["tone"], conversationCount: 3 },
};

function mount(blockers: BotChangeBlocker[] = []) {
  const slot = renderSlot(app.threadLists[0]!, { activeThreadId: "main", activeProjectId: "project", isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" }, {
    sidebarThreads: { projects: [], threads: [thread("main", 1)] },
    rpc: {
      bots_list: () => ({ bots: [bot], hosts: [{ id: "host", name: "Example machine", connected: true }], sections: [], projects: [], threadBindings: [{ botId: bot.id, threadId: "main" }], warnings: [], personalProjectId, projectOwners: [] }),
      bot_delete: (input: unknown) => ({ summary, blockers, exportPath: (input as { dryRun?: boolean }).dryRun ? null : "/data/state/_deleted-bots/bot-20261026T120000Z.json" }),
    },
  });
  return slot;
}
async function openDelete(slot: ReturnType<typeof mount>) {
  fireEvent.contextMenu(await slot.findByText(bot.name));
  fireEvent.click(await slot.findByRole("menuitem", { name: "Delete bot…" }));
  return await slot.findByRole("dialog", { name: `Delete ${bot.name}?` });
}
const deleteCalls = (slot: ReturnType<typeof mount>) => slot.inspection.rpcCalls.filter((call) => call.method === "bot_delete").map((call) => call.input);

it("confirms a delete from the bot's menu, naming the bot and what is lost", async () => {
  const slot = mount();
  const dialog = await openDelete(slot);
  await within(dialog).findByText(/42 characters of memory/);
  expect(dialog.textContent).toMatch(/instructions \(SOUL\)/);
  expect(dialog.textContent).toMatch(/settings \(tone\)/);
  expect(dialog.textContent).toMatch(/3 conversations stay as ordinary threads/);
  expect(deleteCalls(slot)).toEqual([{ botId: bot.id, expectedUpdatedAt: bot.updatedAt, dryRun: true }]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete bot" }));
  await within(dialog).findByText(/bot-20261026T120000Z\.json/);
  expect(deleteCalls(slot)).toEqual([{ botId: bot.id, expectedUpdatedAt: bot.updatedAt, dryRun: true }, { botId: bot.id, expectedUpdatedAt: bot.updatedAt }]);
});

it("shows blockers and does not offer the delete", async () => {
  const slot = mount([{ code: "project_owned", message: "Test bot owns Example project. Release it first." }]);
  const dialog = await openDelete(slot);
  await within(dialog).findByText(/Release it first/);
  expect((within(dialog).getByRole("button", { name: "Delete bot" }) as HTMLButtonElement).disabled).toBe(true);
  expect(deleteCalls(slot)).toHaveLength(1);
});

it("shows an agent's delete request with what goes and what stays", async () => {
  const submit = vi.fn(async () => {});
  const payload: BotChangeApproval = { ...summary, requestedBy: { threadId: "agent", botName: "Warden" } };
  const view = render(<BotChangeApprovalForm interaction={{ id: "i", title: "Delete bot Test bot", payload } as never} submit={submit} cancel={async () => {}} />);
  expect(view.container.textContent).toMatch(/Requested by bot Warden via bb bots delete/);
  expect(view.container.textContent).toMatch(/42 characters/);
  expect(view.container.textContent).toMatch(/3, kept as ordinary threads/);
  fireEvent.click(view.getByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ approved: true }));
});
