import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const FAKE = path.join(ROOT, "test", "fixtures", "fake-gemini.mjs");
const run = promisify(execFile);

beforeAll(async () => {
  await run(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", ROOT]);
}, 120_000);

describe("minion CLI (built) with a fake Gemini CLI over stdio", () => {
  it("run --no-review → review list → ledger", async () => {
    const dir = await tempDir();
    const repo = await makeRepo(dir);
    await writeFile(path.join(dir, "minion.config.json"), JSON.stringify({
      geminiCommand: process.execPath,
      geminiArgs: [FAKE, "--acp"],
      stateDir: "state",
      outDir: "out",
      defaultRepo: "tj/commander.js",
    }));
    const env = { ...process.env, FAKE_SCENARIO: "1" };
    const minion = (...args: string[]) => run(process.execPath, [CLI, ...args], { cwd: dir, env });

    const r = await minion("run", "--notes", path.join(ROOT, "samples", "04-team-sync-2026-11-20.md"), "--meeting", "Team sync 2026-11-20", "--src", repo, "--no-review");
    expect(r.stdout).toContain("minion review team-sync-2026-11-20");
    expect(r.stderr).toContain("Starting the AI agent");
    expect(r.stderr).toContain("ReadFile lib/command.js");
    expect(existsSync(path.join(dir, "out"))).toBe(false);

    const runLog = await readFile(path.join(dir, "state", "pending", "team-sync-2026-11-20.log"), "utf8");
    expect(runLog).toContain("EVENT =====\ntool_call: ReadFile lib/command.js (read)");
    expect(runLog).toContain("EVENT =====\npermission DENIED: WriteFile notes.md (edit)");
    expect(runLog).toMatch(/SUMMARY =====\nFinished in \d+ s: 1 draft\(s\), 0 not drafted\./);
    expect(r.stderr).toContain("denied (read-only policy): WriteFile notes.md");

    const pending = JSON.parse(await readFile(path.join(dir, "state", "pending", "team-sync-2026-11-20.json"), "utf8"));
    expect(pending.drafts[0].draft.refs[0].permalink).toContain("https://github.com/tj/commander.js/blob/");

    expect((await minion("review")).stdout).toMatch(/^team-sync-2026-11-20\t1 draft\(s\)/);
    // review needs a TTY; in a pipe it explains the alternative
    await expect(minion("review", "team-sync-2026-11-20")).rejects.toMatchObject({ stderr: expect.stringContaining("minion web") });
    expect((await minion("ledger", "list")).stdout).toContain("The ledger is empty.");

    await expect(minion("run", "--notes", "missing.docx", "--meeting", "x", "--src", repo)).rejects.toMatchObject({ stderr: expect.stringContaining("Download as Markdown") });
    expect(await readdir(path.join(dir, "state"))).toEqual(["pending"]);
  }, 60_000);

  it("run --each: one meeting per file, titles from file names, without code", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "minion.config.json"), JSON.stringify({
      geminiCommand: process.execPath, geminiArgs: [FAKE, "--acp"], stateDir: "state", outDir: "out", defaultRepo: "tj/commander.js",
    }));
    const a = path.join(dir, "Sprint Review_ VTP – 2026_11_17 – Notizen von Gemini.md");
    const b = path.join(dir, "Team sync - Notes by Gemini.md");
    await writeFile(a, await readFile(path.join(ROOT, "samples", "04-team-sync-2026-11-20.md"), "utf8"));
    await writeFile(b, (await readFile(path.join(ROOT, "samples", "04-team-sync-2026-11-20.md"), "utf8")) + "\nExtra line.\n");
    const r = await run(process.execPath, [CLI, "run", "--each", "--no-review", "--notes", a, b], { cwd: dir, env: { ...process.env, FAKE_SCENARIO: "1" } });
    expect(r.stdout).toContain("=== Meeting 1/2: Sprint Review: VTP – 2026_11_17 ===");
    expect(r.stdout).toContain("=== Meeting 2/2: Team sync ===");
    expect(r.stderr).toContain("No local code folder: tickets are drafted without code links.");
    expect(r.stderr).not.toContain("searching related code");
    const pending = (await readdir(path.join(dir, "state", "pending"))).filter((f) => f.endsWith(".json")).sort();
    expect(pending).toEqual(["sprint-review-vtp-2026-11-17.json", "team-sync.json"]);
  }, 60_000);
});
