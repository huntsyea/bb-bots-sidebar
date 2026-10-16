// Shared by the server (bb.ui.requestInput) and the app (pendingInteraction).
// Pure module: no zod or server imports, so the app bundle stays small.
export const BOT_CHANGE_APPROVAL_RENDERER = "bot-change-approval";

/** What the approval form shows; the server re-validates on approval. */
export interface BotChangeApproval {
  kind: "create" | "update";
  name: string;
  role: string;
  soul: string;
  sectionId: string | null;
  section: string | null;
  linkedProjectIds: string[];
  ownedProjectIds: string[];
  projects: { id: string; name: string; owner: boolean }[];
  hidden: boolean;
  /** For updates: the identity being replaced. */
  previous?: { name: string; role: string; soul: string };
  /** The BB thread that ran the command, and its bot when it has one. */
  requestedBy: { threadId: string; botName: string | null } | null;
}
