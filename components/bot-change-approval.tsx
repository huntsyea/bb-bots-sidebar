import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { BotChangeApproval } from "../lib/bot-change-approval";
import { Button } from "./ui/button";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

function Instructions({ text }: { text: string }) {
  return text
    ? <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{text}</pre>
    : <span className="text-muted-foreground">None</span>;
}

/**
 * The form an agent's `bb bots create` / `update` waits on when “Agents may
 * create bots” is Ask. It shows exactly what will be saved; the server
 * re-validates everything after approval.
 */
export function BotChangeApprovalForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const change = interaction.payload as unknown as BotChangeApproval;
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);
  const answer = (approved: boolean) => {
    setPending(approved ? "approve" : "decline");
    submit({ approved }).catch(() => setPending(null));
  };
  const previous = change.previous;
  const renamed = previous && previous.name !== change.name;
  const roleChanged = previous && previous.role !== change.role;
  const soulChanged = !previous || previous.soul !== change.soul;
  const requester = change.requestedBy?.botName ? `bot ${change.requestedBy.botName}` : "an agent in this thread";
  return (
    <section className="bot-change-approval flex flex-col gap-3 p-3" aria-label={interaction.title}>
      <p className="text-xs text-muted-foreground">Requested by {requester} via <code>bb bots {change.kind}</code>. A bot's instructions apply to every future conversation with it.</p>
      <dl className="flex flex-col gap-1.5">
        {renamed ? <Field label="Name">{previous.name} → <strong>{change.name}</strong></Field> : change.kind === "create" ? <Field label="Name"><strong>{change.name}</strong></Field> : null}
        {change.kind === "create" || roleChanged ? <Field label="Role">{roleChanged ? <>{previous.role || "—"} → </> : null}{change.role || "—"}</Field> : null}
        {change.kind === "create" ? <>
          <Field label="Section">{change.section ?? "Main"}</Field>
          <Field label="Projects">{change.projects.length ? change.projects.map((project) => `${project.name}${project.owner ? " (owner)" : ""}`).join(", ") : "None"}</Field>
          {change.hidden ? <Field label="Sidebar">Hidden until it has activity</Field> : null}
        </> : null}
        {soulChanged ? <Field label={change.kind === "create" ? "Instructions" : "New instructions"}><Instructions text={change.soul} /></Field> : null}
      </dl>
      <footer className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => answer(false)}>{pending === "decline" ? "Declining…" : "Decline"}</Button>
        <Button type="button" size="sm" disabled={pending !== null} onClick={() => answer(true)}>{pending === "approve" ? "Approving…" : change.kind === "create" ? "Create bot" : "Save changes"}</Button>
      </footer>
      {/* Escape hatch the host also offers; kept explicit for keyboard users. */}
      <button type="button" className="sr-only" onClick={() => void cancel()}>Dismiss without answering</button>
    </section>
  );
}
