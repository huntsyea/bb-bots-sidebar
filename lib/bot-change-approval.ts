// Shared by the server (bb.ui.requestInput) and the app (pendingInteraction).
// Pure module: no zod or server imports, so the app bundle stays small.
export const BOT_CHANGE_APPROVAL_RENDERER = "bot-change-approval";

/**
 * A checked bot change as people see it: what `--dry-run` prints and what the
 * approval form shows. The bot write module produces it; nobody builds it by hand.
 */
export interface BotChangeSummary {
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
}

/** What the approval form shows; the server checks the change again after approval. */
export interface BotChangeApproval extends BotChangeSummary {
  /** The BB thread that ran the command, and its bot when it has one. */
  requestedBy: { threadId: string; botName: string | null } | null;
}
