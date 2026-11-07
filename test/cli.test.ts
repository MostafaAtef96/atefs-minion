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
    expect(r.stderr).toContain("Starting Gemini CLI");
    expect(r.stderr).toContain("ReadFile lib/command.js");
    expect(existsSync(path.join(dir, "out"))).toBe(false);

    const pending = JSON.parse(await readFile(path.join(dir, "state", "pending", "team-sync-2026-11-20.json"), "utf8"));
    expect(pending.drafts[0].draft.refs[0].permalink).toContain("https://github.com/tj/commander.js/blob/");

    expect((await minion("review")).stdout).toMatch(/^team-sync-2026-11-20\t1 draft\(s\)/);
    // review needs a TTY; in a pipe it explains the alternative
    await expect(minion("review", "team-sync-2026-11-20")).rejects.toMatchObject({ stderr: expect.stringContaining("minion web") });
    expect((await minion("ledger", "list")).stdout).toContain("The ledger is empty.");

    await expect(minion("run", "--notes", "missing.docx", "--meeting", "x", "--src", repo)).rejects.toMatchObject({ stderr: expect.stringContaining("Download as Markdown") });
    expect(await readdir(path.join(dir, "state"))).toEqual(["pending"]);
  }, 60_000);
});
