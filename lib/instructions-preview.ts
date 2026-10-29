import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotStore } from "./bot-store";
import { botInstructions } from "./bot-instructions";
import { botProjectContext } from "./project-context";

/**
 * The instruction block a bot's conversation in `projectId` receives, built
 * by the same botInstructions() call the agent configure path makes. Read-only
 * (BBP-73, for Memory Lab): it reads the stored record and never prepares state.
 */
export async function instructionsPreview(bb: BbPluginApi, store: BotStore, { botId, projectId }: { botId: string; projectId: string }) {
  const bot = store.get(botId);
  if (!bot) throw new Error(`Bot not found: ${botId}`);
  const project = (await bb.sdk.projects.list({ includePersonal: true })).find((entry) => entry.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const context = botProjectContext(bot, project, store);
  const instructions = botInstructions(bot, context);
  return { botId, projectId, mode: context.role, instructions, characters: instructions.length };
}
