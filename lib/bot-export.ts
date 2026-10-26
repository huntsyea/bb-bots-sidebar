import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { metadataSchema } from "../contract";
import { stateContent } from "./private-state";

/**
 * The restore source a delete leaves behind: one JSON file per deleted bot in
 * `state/_deleted-bots/` under the plugin's data folder. `state/` is what the
 * reload backup copies; a leading underscore can never be a bot ID, so the
 * folder never meets a bot's own export directory.
 */
export const DELETED_BOTS_DIRECTORY = "_deleted-bots";
export const BOT_EXPORT_FORMAT = "bots-sidebar.deleted-bot";

const exportSchema = z.object({
  format: z.literal(BOT_EXPORT_FORMAT),
  version: z.literal(1),
  deletedAt: z.string(),
  /** The bot's full stored record: identity, SOUL, memory, settings, launch preset, hashes. */
  bot: metadataSchema,
  /** Conversations that were bound to the bot; they remain as ordinary threads. */
  bindings: z.array(z.string()),
  ownedProjectIds: z.array(z.string()),
  /** Legacy import records kept for this bot, if any. */
  legacy: z.object({ state: z.json().nullable(), record: z.json().nullable() }).strict(),
  /** The state files as the bot saw them, for reading by eye. */
  files: z.object({ "SOUL.md": z.string(), "MEMORY.md": z.string(), "settings.json": z.string() }).strict(),
}).strict();
export type BotExport = z.infer<typeof exportSchema>;

/** Parses an export and checks that its readable files match the stored record. */
export function readBotExport(text: string): BotExport {
  const parsed = exportSchema.parse(JSON.parse(text));
  for (const file of ["SOUL.md", "MEMORY.md", "settings.json"] as const) {
    if (parsed.files[file] !== stateContent(parsed.bot, file)) throw new Error(`Bot export ${file} does not match its record`);
  }
  return parsed;
}

function privateDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!lstatSync(path).isDirectory()) throw new Error("Bot export folder must be a real directory, not a file or symlink");
}

/**
 * Writes the export with a new name (never over an existing file), flushes it
 * to disk and reads it back. Returns the path only once the file restores.
 */
export function writeBotExport(stateRoot: string, input: Omit<BotExport, "format" | "version" | "files">): string {
  const value: BotExport = {
    format: BOT_EXPORT_FORMAT, version: 1, ...input,
    files: { "SOUL.md": stateContent(input.bot, "SOUL.md"), "MEMORY.md": stateContent(input.bot, "MEMORY.md"), "settings.json": stateContent(input.bot, "settings.json") },
  };
  const content = `${JSON.stringify(value, null, 2)}\n`;
  privateDirectory(stateRoot);
  const directory = join(stateRoot, DELETED_BOTS_DIRECTORY);
  privateDirectory(directory);
  const stamp = input.deletedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let attempt = 0; ; attempt++) {
    const path = join(directory, `${input.bot.id}-${stamp}${attempt ? `-${attempt}` : ""}.json`);
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt < 100) continue; throw error; }
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    const restored = readBotExport(readFileSync(path, "utf8"));
    if (JSON.stringify(restored.bot) !== JSON.stringify(metadataSchema.parse(input.bot))) throw new Error("Bot export did not read back as written");
    return path;
  }
}

