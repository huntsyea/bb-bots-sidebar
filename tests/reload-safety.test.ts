import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

const script = resolve("scripts/reload-safety.sh");
function environment(root: string, failure = "") {
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Every backup uses this stub; tests must never disable the installed plugin.
  writeFileSync(join(bin, "bb"), `#!/bin/bash
echo "$*" >> "$TEST_ROOT/commands"
case "$*" in
  'plugin list --json')
    if [[ "$TEST_FAILURE" == already-disabled ]]; then
      echo '{"plugins":[{"id":"bots-sidebar","enabled":false}]}'
    else
      echo '{"plugins":[{"id":"bots-sidebar","enabled":true}]}'
    fi;;
  'plugin disable bots-sidebar')
    [[ "$TEST_FAILURE" != disable ]] || exit 1
    touch "$TEST_ROOT/disabled";;
  'plugin enable bots-sidebar')
    [[ "$TEST_FAILURE" != enable ]] || exit 1
    rm -f "$TEST_ROOT/disabled";;
  *) exit 99;;
esac
`, { mode: 0o700 });
  writeFileSync(join(bin, "cp"), `#!/bin/bash
echo copy >> "$TEST_ROOT/commands"
[[ -f "$TEST_ROOT/disabled" ]] || exit 99
[[ "$TEST_FAILURE" != copy ]] || exit 1
exec /bin/cp "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, "git"), `#!/bin/bash
[[ "$1" == -C ]] || exit 99
shift 2
case "$*" in
  'rev-parse --show-toplevel') exit 1;;
  'branch --show-current') echo main;;
  'status --porcelain') [[ "$TEST_FAILURE" != dirty ]] || echo ' M file';;
  'merge --ff-only sync/test')
    echo "$*" >> "$TEST_ROOT/commands"
    [[ -f "$TEST_ROOT/disabled" ]] || exit 99
    [[ "$TEST_FAILURE" != merge ]] || exit 1
    touch "$TEST_ROOT/merged";;
  *) exit 99;;
esac
`, { mode: 0o700 });
  writeFileSync(join(bin, "npm"), `#!/bin/bash
echo "npm $*" >> "$TEST_ROOT/commands"
[[ -f "$TEST_ROOT/disabled" && -f "$TEST_ROOT/merged" ]] || exit 99
case "$*" in
  ci) [[ "$TEST_FAILURE" != ci ]] || exit 1;;
  'run build') [[ "$TEST_FAILURE" != build ]] || exit 1;;
  *) exit 99;;
esac
`, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TEST_FAILURE: failure };
}

it("backs up SQLite and state, strips only presets, and can repeat the strip", () => {
  const root = mkdtempSync(join(tmpdir(), "bots reload's-"));
  try {
    const env = environment(root);
    const run = (...args: string[]) => execFileSync("bash", [script, ...args], { env, encoding: "utf8" }).trim();
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
      expect(readFileSync(join(root, "commands"), "utf8")).toBe(
        "plugin list --json\nplugin disable bots-sidebar\ncopy\nplugin enable bots-sidebar\n",
      );
      expect(run("count-launch-presets", join(backup, "data.db"))).toBe("2");
      expect(readFileSync(join(backup, "state", "sentinel.md"), "utf8")).toBe("private state\n");
      expect(run("strip-launch-presets", join(backup, "data.db"))).toBe("2");
      expect(run("strip-launch-presets", join(backup, "data.db"))).toBe("0");
      expect(run("count-launch-presets", join(backup, "data.db"))).toBe("0");
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
      expect(db.prepare("SELECT data FROM bots WHERE id = 'null'").get()).toEqual({ data: JSON.stringify(rows[1]) });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("backs up a WAL database whose sidecars were removed when the plugin closed it", () => {
  const root = mkdtempSync(join(tmpdir(), "bots-reload-wal-"));
  try {
    const env = environment(root);
    const source = join(root, "source");
    const backups = join(root, "backups");
    mkdirSync(join(source, "state"), { recursive: true });
    mkdirSync(backups);
    const database = join(source, "data.db");
    const db = new Database(database);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE bots(data TEXT)");
    db.prepare("INSERT INTO bots VALUES (?)").run(JSON.stringify({ name: "Bot", launchPreset: { model: "test" } }));
    // Closing the last connection checkpoints and deletes -wal/-shm, as disabling the plugin does.
    db.close();
    expect(readFileSync(database)[18]).toBe(2);
    expect(existsSync(`${database}-wal`) || existsSync(`${database}-shm`)).toBe(false);
    const result = spawnSync("bash", [script, "backup", source, backups], { env, encoding: "utf8" });
    expect(result.stderr).not.toContain("unable to open database file");
    expect(result.status).toBe(0);
    const backup = result.stdout.trim();
    expect(readdirSync(backups)).toEqual([basename(backup)]);
    const sqlite = (path: string, sql: string) => execFileSync("sqlite3", [path, sql], { encoding: "utf8" }).trim();
    expect(sqlite(join(backup, "data.db"), "PRAGMA journal_mode;")).toBe("delete");
    expect(sqlite(join(backup, "data.db"), "PRAGMA integrity_check;")).toBe("ok");
    expect(execFileSync("bash", [script, "count-launch-presets", join(backup, "data.db")], { encoding: "utf8" }).trim()).toBe("1");
    expect(sqlite(database, "PRAGMA journal_mode;")).toBe("wal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["", "copy", "database", "merge","ci", "build", "enable", "disable", "already-disabled", "dirty"])(
  "keeps one outage through reload and handles failure at %s", (failure) => {
    const root = mkdtempSync(join(tmpdir(), "bots reload's-"));
    try {
      const env = environment(root, failure);
      const source = join(root, "source");
      const backups = join(root, "backups");
      mkdirSync(join(source, "state"), { recursive: true });
      mkdirSync(backups);
      writeFileSync(join(source, "state", "sentinel.md"), "private state\n");
      const db = new Database(join(source, "data.db"));
      db.exec("CREATE TABLE bots(data TEXT)");
      db.close();
      if (failure === "database") writeFileSync(join(source, "data.db"), "invalid database");
      const result = spawnSync("bash", [script, "reload", "sync/test", source, backups], { env, encoding: "utf8" });
      expect(result.status).toBe(failure ? 1 : 0);
      const commands = existsSync(join(root, "commands")) ? readFileSync(join(root, "commands"), "utf8") : "";
      const steps = [
        "plugin list --json", "plugin disable bots-sidebar", "copy",
        "merge --ff-only sync/test", "npm ci", "npm run build", "plugin enable bots-sidebar",
      ];
      const stop = { copy: 2, database: 1, merge: 3, ci: 4, build: 5, enable: 6, disable: 1 }[failure];
      const expected = failure === "dirty" ? [] : failure === "already-disabled" ? steps.slice(0, 1)
        : stop === undefined ? steps : [...steps.slice(0, stop + 1), "plugin enable bots-sidebar"];
      expect(commands).toBe(expected.length ? expected.join("\n") + "\n" : "");
      expect(existsSync(join(root, "merged"))).toBe(["", "ci", "build", "enable"].includes(failure));
      expect(existsSync(join(root, "disabled"))).toBe(failure === "enable");
      // A failed backup is removed; a completed one is kept even if a later step fails.
      expect(readdirSync(backups)).toHaveLength(["", "merge", "ci", "build", "enable"].includes(failure) ? 1 : 0);
      if (["copy", "database", "disable"].includes(failure)) expect(result.stderr).toContain("Backup failed; removed incomplete");
      if (!failure) {
        const backup = result.stdout.trim();
        expect(readFileSync(join(backup, "state", "sentinel.md"), "utf8")).toBe("private state\n");
        expect(execFileSync("sqlite3", [join(backup, "data.db"), "PRAGMA integrity_check;"], { encoding: "utf8" }).trim()).toBe("ok");
      }
      if (["merge", "ci", "build", "enable"].includes(failure)) expect(result.stderr).toContain("Backup: ");
      if (failure === "enable") expect(result.stderr).toContain("Could not re-enable bots-sidebar");
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);

it.each(["copy", "disable", "enable", "database", "already-disabled"])("fails safely when %s prevents backup", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "bots-reload-failure-"));
  try {
    const env = environment(root, failure);
    const source = join(root, "source");
    const backups = join(root, "backups");
    mkdirSync(join(source, "state"), { recursive: true });
    mkdirSync(backups);
    const db = new Database(join(source, "data.db"));
    db.exec("CREATE TABLE bots(data TEXT)");
    db.close();
    if (failure === "database") writeFileSync(join(source, "data.db"), "invalid database");
    const result = spawnSync("bash", [script, "backup", source, backups], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    // Only the final enable runs after a completed backup, which is kept.
    expect(readdirSync(backups)).toHaveLength(failure === "enable" ? 1 : 0);
    const commands = readFileSync(join(root, "commands"), "utf8");
    if (failure === "already-disabled") {
      expect(commands).toBe("plugin list --json\n");
    } else {
      expect(commands).toContain("plugin disable bots-sidebar\n");
      expect(commands).toContain("plugin enable bots-sidebar\n");
      if (failure === "disable" || failure === "database") expect(commands).not.toContain("copy\n");
      if (failure === "enable") expect(result.stderr).toContain("Could not re-enable bots-sidebar");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([null, { providerId: "codex", model: "test" }])("counts and strips a present preset (%j)", (launchPreset) => {
  const root = mkdtempSync(join(tmpdir(), "bots-preset-"));
  const database = join(root, "data.db");
  const db = new Database(database);
  try {
    db.exec("CREATE TABLE bots(data TEXT)");
    db.prepare("INSERT INTO bots VALUES (?)").run(JSON.stringify({ name: "Bot", launchPreset }));
    const run = (command: string) => execFileSync("bash", [script, command, database], { encoding: "utf8" }).trim();
    expect(run("count-launch-presets")).toBe("1");
    expect(run("strip-launch-presets")).toBe("1");
    expect(run("count-launch-presets")).toBe("0");
    expect(db.prepare("SELECT data FROM bots").get()).toEqual({ data: '{"name":"Bot"}' });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
