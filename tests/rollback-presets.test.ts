import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { bot } from "./fixtures";

// Real commits of this repository: df530b0 predates 03daa73 and its strict
// schema rejects any launchPreset key; fb8e9b4 is a later build that reads them.
const BEFORE_PRESETS = "df530b0";
const READS_PRESETS = "fb8e9b4";
const repo = resolve(".");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const preset = { execution: null, workspace: "worktree", initialPrompt: "Review the open changes." };
const rows = [
  { ...bot, id: "frontier", name: "Frontier", launchPreset: preset },
  { ...bot, id: "nulled", name: "Nulled", launchPreset: null },
  { ...bot, id: "plain", name: "Plain" },
];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bots rollback's-")); roots.push(root);
  const database = join(root, "data.db");
  const db = new Database(database);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE bots(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE other(value TEXT); INSERT INTO other VALUES ('keep');");
  for (const row of rows) db.prepare("INSERT INTO bots VALUES (?, ?)").run(row.id, JSON.stringify(row));
  db.close();
  const stored = () => {
    const copy = new Database(database, { readonly: true });
    try { return { bots: copy.prepare("SELECT id, data FROM bots ORDER BY id").all() as { id: string; data: string }[], other: copy.prepare("SELECT * FROM other").all() }; }
    finally { copy.close(); }
  };
  return { root, database, stored };
}
function rollback(args: string[], script = join(repo, "scripts/reload-safety.sh")) {
  const result = spawnSync("bash", [script, "rollback-presets", ...args], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

it("leaves a real preset untouched when the rollback target reads presets, and says so", () => {
  const { database, stored } = fixture();
  const before = stored();
  const result = rollback([READS_PRESETS, database]);
  expect(result.status).toBe(0);
  expect(result.out).toMatch(/03daa73 is an ancestor/);
  expect(result.out).toMatch(/schema accepts launchPreset/);
  expect(result.out).toMatch(/Left 2 launch presets untouched/);
  expect(stored()).toEqual(before);
  expect(JSON.parse(stored().bots.find((row) => row.id === "frontier")!.data).launchPreset).toEqual(preset);
});

it("strips presets, and only presets, when the target predates 03daa73", () => {
  const { database, stored } = fixture();
  const result = rollback([BEFORE_PRESETS, database]);
  expect(result.status).toBe(0);
  expect(result.out).toMatch(/03daa73 is not an ancestor/);
  expect(result.out).toMatch(/Stripped 2 launch presets/);
  expect(stored()).toEqual({
    bots: rows.map((row) => { const { launchPreset: _drop, ...rest } = row as typeof row & { launchPreset?: unknown }; return { id: row.id, data: JSON.stringify(rest) }; }).sort((a, b) => a.id.localeCompare(b.id)),
    other: [{ value: "keep" }],
  });
  const again = rollback([BEFORE_PRESETS, database]);
  expect(again.status).toBe(0);
  expect(again.out).toMatch(/No launch presets stored; nothing to strip/);
});

it("reports the decision without changing anything on --dry-run", () => {
  const { database, stored } = fixture();
  const before = stored();
  const result = rollback([BEFORE_PRESETS, database, "--dry-run"]);
  expect(result.status).toBe(0);
  expect(result.out).toMatch(/Would strip 2 launch presets/);
  expect(stored()).toEqual(before);
});

it("strips when the target descends from 03daa73 but its schema rejects the key, and fails closed when it can't probe", () => {
  const { root, database, stored } = fixture();
  // A throwaway clone with one commit whose strict schema no longer has launchPreset.
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repo, clone]);
  execFileSync("git", ["-C", clone, "checkout", "--quiet", "-b", "probe", READS_PRESETS]);
  symlinkSync(join(repo, "node_modules"), join(clone, "node_modules"));
  writeFileSync(join(clone, "scripts/reload-safety.sh"), readFileSync(join(repo, "scripts/reload-safety.sh")));
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" }).trim();
  const contract = join(clone, "contract.ts");
  writeFileSync(contract, readFileSync(contract, "utf8").replace("  launchPreset: launchPresetSchema.nullable().optional(),\n", ""));
  git("commit", "--quiet", "-am", "Fixture: schema without launchPreset");
  const rejecting = git("rev-parse", "HEAD");
  const script = join(clone, "scripts/reload-safety.sh");
  const result = rollback([rejecting, database], script);
  expect(result.status).toBe(0);
  expect(result.out).toMatch(/03daa73 is an ancestor/);
  expect(result.out).toMatch(/schema rejects launchPreset/);
  expect(result.out).toMatch(/Stripped 2 launch presets/);

  const { database: second, stored: storedSecond } = fixture();
  const before = storedSecond();
  writeFileSync(contract, "export const metadataSchema = ;\n");
  git("commit", "--quiet", "-am", "Fixture: contract that cannot be bundled");
  const broken = rollback([git("rev-parse", "HEAD"), second], script);
  expect(broken.status).not.toBe(0);
  expect(broken.out).toMatch(/Could not probe/);
  expect(storedSecond()).toEqual(before);
  expect(stored().bots.every((row) => !("launchPreset" in JSON.parse(row.data)))).toBe(true);
});

it("refuses an unknown target without changing anything", () => {
  const { database, stored } = fixture();
  const before = stored();
  const result = rollback(["no-such-ref", database]);
  expect(result.status).not.toBe(0);
  expect(result.out).toMatch(/Unknown rollback target/);
  expect(stored()).toEqual(before);
});
