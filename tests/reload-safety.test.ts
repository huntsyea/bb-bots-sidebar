import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

const script = resolve("scripts/reload-safety.sh");
const run = (...args: string[]) => execFileSync("bash", [script, ...args], { encoding: "utf8" }).trim();

it("backs up SQLite and state, strips only presets, and can repeat the strip", () => {
  const root = mkdtempSync(join(tmpdir(), "bots reload's-"));
  try {
    const source = join(root, "source");
    const backups = join(root, "backups");
    mkdirSync(join(source, "state"), { recursive: true });
    mkdirSync(backups);
    writeFileSync(join(source, "state", "sentinel.md"), "private state\n");
    const db = new Database(join(source, "data.db"));
    try {
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE bots(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE other(value TEXT); INSERT INTO other VALUES ('keep');");
      const rows = [
        { id: "preset", name: "Bot", launchPreset: { model: "test" }, settings: { launchPreset: "keep" } },
        { id: "null", launchPreset: null },
        { id: "absent", name: "Other" },
      ];
      for (const row of rows) db.prepare("INSERT INTO bots VALUES (?, ?)").run(row.id, JSON.stringify(row));
      const backup = run("backup", source, backups);
      expect(readFileSync(join(backup, "state", "sentinel.md"), "utf8")).toBe("private state\n");
      expect(run("strip-launch-presets", join(backup, "data.db"))).toBe("2");
      expect(run("strip-launch-presets", join(backup, "data.db"))).toBe("0");
      const copy = new Database(join(backup, "data.db"), { readonly: true });
      try {
        expect(copy.prepare("SELECT data FROM bots ORDER BY id").all()).toEqual([
          { data: JSON.stringify(rows[2]) },
          { data: JSON.stringify({ id: "null" }) },
          { data: JSON.stringify({ id: "preset", name: "Bot", settings: { launchPreset: "keep" } }) },
        ]);
        expect(copy.prepare("SELECT * FROM other").all()).toEqual([{ value: "keep" }]);
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally { copy.close(); }
      expect(db.prepare("SELECT data FROM bots WHERE id = 'preset'").get()).toEqual({ data: JSON.stringify(rows[0]) });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
