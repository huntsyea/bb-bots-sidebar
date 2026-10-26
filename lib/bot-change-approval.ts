// Shared by the server (bb.ui.requestInput) and the app (pendingInteraction).
// Pure module: no zod or server imports, so the app bundle stays small.
export const BOT_CHANGE_APPROVAL_RENDERER = "bot-change-approval";

/**
 * A checked bot change as people see it: what `--dry-run` prints and what the
 * approval form shows. The bot write module produces it; nobody builds it by hand.
 */
export interface BotChangeSummary {
  kind: "create" | "update" | "delete";
  name: string;
  role: string;
  soul: string;
  sectionId: string | null;
  section: string | null;
  linkedProjectIds: string[];
  ownedProjectIds: string[];
  projects: { id: string; name: string; owner: boolean }[];
  hidden: boolean;
  /** For updates and deletes: the identity being replaced or removed. */
  previous?: { name: string; role: string; soul: string };
  /** For deletes: what goes with the bot. Its conversations stay as ordinary threads. */
  removal?: { memoryCharacters: number; settingsKeys: string[]; conversationCount: number };
}

/** Why a change can't be made yet, for example a delete while the bot owns a project. */
export interface BotChangeBlocker { code: string; message: string }

/** What the approval form shows; the server checks the change again after approval. */
export interface BotChangeApproval extends BotChangeSummary {
  /** The BB thread that ran the command, and its bot when it has one. */
  requestedBy: { threadId: string; botName: string | null } | null;
}
