import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { SIDEBAR_MODES, modeForProvider } from "../lib/sidebar-mode";
import type { SidebarMode } from "../lib/sidebar-mode";
import { usePortalScopeProps } from "../lib/portal-scope";

const LABELS: Record<SidebarMode, string> = { code: "Code", bots: "Bots" };
// BB renders the active thread list provider inside this element. The tab bar
// sits directly above it, so it stays put whichever provider is active.
const SIDEBAR_BODY = '[data-testid="app-sidebar-body"]';
const SIDEBAR_CONTENT = ':scope > [data-sidebar="content"]';
const HOST_ATTRIBUTE = "data-bots-sidebar-mode-tabs";

/**
 * Keeps one host element mounted just above the sidebar's thread-list area.
 * `listKey` changes, and `onListChange` fires, whenever BB swaps the list
 * inside it (a provider change, including one made in Settings → Appearance).
 */
function useSidebarTabsHost(onListChange: () => void) {
  const [state, setState] = useState<{ host: HTMLElement | null; listKey: number }>({ host: null, listKey: 0 });
  const listChanged = useRef(onListChange);
  listChanged.current = onListChange;
  useEffect(() => {
    const element = document.createElement("div");
    element.setAttribute(HOST_ATTRIBUTE, "");
    let frame = 0;
    let content: HTMLElement | null = null;
    let list: Element | null | undefined;
    const place = () => {
      frame = 0;
      content = document.querySelector(SIDEBAR_BODY)?.querySelector<HTMLElement>(SIDEBAR_CONTENT) ?? null;
      if (!content) {
        element.remove();
        setState((current) => current.host ? { ...current, host: null } : current);
        return;
      }
      if (element.nextElementSibling !== content) content.before(element);
      const current = content.firstElementChild;
      const swapped = list !== undefined && current !== list;
      list = current;
      setState((previous) => previous.host === element && !swapped ? previous : { host: element, listKey: previous.listKey + (swapped ? 1 : 0) });
      if (swapped) listChanged.current();
    };
    // The observer sees every app mutation (streaming messages included), so
    // skip the frame and DOM query unless the anchor or the list itself moved.
    const unchanged = () => content !== null && content.isConnected && element.nextElementSibling === content && content.firstElementChild === list;
    const observer = new MutationObserver(() => { if (!frame && !unchanged()) frame = requestAnimationFrame(place); });
    place();
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); element.remove(); };
  }, []);
  return state;
}

// With BB's automatic provider choice, read the active tab off the list BB
// actually rendered: ours carries .bots-sidebar, any other list is Code.
function renderedMode(host: HTMLElement, provider: string | null): SidebarMode | null {
  if (provider === null) return null;
  return host.nextElementSibling?.querySelector(".bots-sidebar") ? "bots" : "code";
}

export function SidebarModeTabBar({ mode, pending, onSelect }: { mode: SidebarMode | null; pending: boolean; onSelect: (mode: SidebarMode) => void }) {
  return (
    <div role="tablist" aria-label="Sidebar view" aria-busy={pending || undefined} className="sidebar-tablist mx-2 mb-1.5 grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = mode === "bots" ? "code" : "bots";
      onSelect(next);
      event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
    }}>
      {SIDEBAR_MODES.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-mode={id}
          aria-selected={mode === id}
          tabIndex={mode === id || (mode === null && id === "code") ? 0 : -1}
          data-state={mode === id ? "active" : "inactive"}
          className="sidebar-tab h-6 rounded-md text-xs font-medium text-muted-foreground"
          onClick={() => onSelect(id)}
        >
          {LABELS[id]}
        </button>
      ))}
    </div>
  );
}

/**
 * Code / Bots switcher, modelled on the Chat / Code toggle in the Claude app.
 * Bots pins this plugin's list; Code pins whichever other list the user chose
 * in Settings → Appearance → Sidebar (BB's own list until they choose one).
 * Both write BB's `sidebar.threadListProvider` preference, so the choice syncs
 * across windows.
 */
export function SidebarModeTabs() {
  const rpc = useRpc<typeof rpcContract>();
  const portalScope = usePortalScopeProps();
  const [provider, setProvider] = useState<string | null>(null);
  const [pending, setPending] = useState<SidebarMode | null>(null);

  // Responses can arrive out of order (a focus refresh racing a tab click);
  // only the latest request may update the provider.
  const latestRequest = useRef(0);
  const apply = useCallback((request: Promise<{ provider: string }>) => {
    const id = ++latestRequest.current;
    return request.then(({ provider }) => { if (id === latestRequest.current) setProvider(provider); });
  }, []);
  // Reading also lets the server remember a non-Bots list as the Code tab's.
  const refresh = useCallback(() => {
    apply(rpc.call("sidebar_mode_get", null)).catch(() => {});
  }, [apply, rpc]);
  // A list swap re-renders this component, so renderedMode() sees the new list.
  const { host } = useSidebarTabsHost(refresh);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const select = (mode: SidebarMode) => {
    if (pending || modeForProvider(provider) === mode) return;
    setPending(mode);
    apply(rpc.call("sidebar_mode_set", { mode }))
      .catch(refresh)
      .finally(() => setPending(null));
  };

  if (!host) return null;
  return createPortal(
    <div {...portalScope} className="bots-sidebar-mode-tabs">
      <SidebarModeTabBar mode={pending ?? modeForProvider(provider) ?? renderedMode(host, provider)} pending={pending !== null} onSelect={select} />
    </div>,
    host,
  );
}
