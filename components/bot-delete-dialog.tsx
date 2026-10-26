import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BotMetadata } from "../contract";
import type { BotChangeBlocker, BotChangeSummary } from "../lib/bot-change-approval";

type Check = { summary: BotChangeSummary; blockers: BotChangeBlocker[]; exportPath: string | null };

/**
 * Confirms deleting a bot. It shows the server's checked delete (what goes,
 * what stays, any blockers), then deletes against the same revision.
 */
export function BotDeleteDialog({ bot, check, onDeleted, onClose }: {
  bot: BotMetadata;
  check: (dryRun: boolean) => Promise<Check>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Check | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = useRef(false);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    checkRef.current(true).then(setPreview, (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  async function remove() {
    if (deleting.current) return;
    deleting.current = true; setPending(true); setError(null);
    try {
      const result = await check(false);
      setExportPath(result.exportPath);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      deleting.current = false; setPending(false);
    }
  }

  const removal = preview?.summary.removal;
  const blockers = preview?.blockers ?? [];
  const conversations = removal?.conversationCount ?? 0;
  return <Dialog open onOpenChange={(open) => { if (!open && !deleting.current) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{`Delete ${bot.name}?`}</DialogTitle>
        <DialogDescription>{exportPath ? "The bot was deleted." : "This removes the bot from the sidebar, the CLI and its own tools. An export is saved first."}</DialogDescription>
      </DialogHeader>
      {exportPath ? <p className="text-xs">Export saved to <code className="break-all">{exportPath}</code></p> : removal ? <div className="space-y-2 text-xs">
        <p>Deleting removes its instructions (SOUL), {removal.memoryCharacters} characters of memory and {removal.settingsKeys.length ? `its settings (${removal.settingsKeys.join(", ")})` : "its settings"}.</p>
        <p className="text-muted-foreground">{conversations} conversation{conversations === 1 ? "" : "s"} stay{conversations === 1 ? "s" : ""} as ordinary threads, with titles and history.</p>
        {blockers.map((blocker) => <p key={blocker.code + blocker.message} role="alert" className="text-destructive">{blocker.message}</p>)}
      </div> : error ? null : <p className="text-xs text-muted-foreground">Checking…</p>}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        {exportPath ? <Button type="button" onClick={onClose}>Close</Button> : <>
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={pending || !preview || blockers.length > 0} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete bot"}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
