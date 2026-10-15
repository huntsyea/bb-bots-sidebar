import { beforeEach } from "vitest";

// Sidebar UI tests exercise the full Bots list, including the opt-in
// unassigned Chats pane. sidebar-mode-tabs.test.tsx covers the default.
beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.setItem("bots:show-chats", "true");
});
