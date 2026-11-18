#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, type MinionConfig } from "../core/config.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { finalize, linkIssue, readRecap, removeDraft, type FinalizeResult } from "../core/finalize.js";
import { setSignatureImage } from "../core/render.js";
import { InputError, meetingTitleFromFile, readNotesFiles } from "../core/inputs.js";
import { generate, MeetingAlreadyProcessedError } from "../core/pipeline.js";
import { Store } from "../core/store.js";
import { GeminiAgentFactory } from "../control/acp.js";
import { startWebServer } from "../web/server.js";
import { reviewInTerminal } from "./review.js";

const program = new Command();
program
  .name("minion")
  .description("Atef's Minion — turns Gemini meeting notes into reviewed ticket drafts.")
  .option("-c, --config <file>", "config file (default: ./minion.config.json)")
  .option("--out <dir>", "output folder for approved drafts")
  .option("--no-log", "do not keep prompts/responses in run.log");

function config(): MinionConfig {
  const opts = program.opts<{ config?: string; out?: string; log: boolean }>();
  const cfg = loadConfig(opts.config);
  setSignatureImage(cfg.signatureImage);
  if (opts.out) cfg.outDir = opts.out;
  if (!opts.log) cfg.logPrompts = false;
  return cfg;
}

export function geminiFactory(cfg: MinionConfig, onActivity?: (m: string) => void): GeminiAgentFactory {
  return new GeminiAgentFactory({
    command: cfg.geminiCommand,
    args: cfg.geminiArgs,
    model: cfg.model,
    timeoutMs: cfg.promptTimeoutSec * 1000,
    onActivity,
  });
}

function printResult(r: FinalizeResult): void {
  console.log("");
  for (const w of r.written) console.log(`Saved:    ${w.title}\n          ${w.file}`);
  for (const m of r.merged) console.log(`Merged:   into existing draft ${m.into}${m.file ? `\n          ${m.file}` : ""}`);
  for (const t of r.rejected) console.log(`Rejected: ${t}`);
  if (r.outDir) console.log(`\nDrafts and manifest: ${r.outDir}`);
  if (r.indexPage) console.log(`Open ${r.indexPage} to create the tickets on GitHub (one click each).`);
  if (r.recap) console.log(`Meeting recap for the attendees: ${r.recap}  (print it with "minion recap <meeting-id>")`);
}

program
  .command("run")
  .description("draft tickets from meeting notes and review them (several meetings: add --each)")
  .requiredOption("-n, --notes <files...>", "exported Gemini notes (.md or .txt); with --each, one file per meeting")
  .option("-m, --meeting <title>", "meeting title (default: taken from the file name)")
  .option("-r, --repo <owner/name>", "GitHub repository the tickets are for")
  .option("-s, --src <path>", "local copy (git clone) of that repository, for code links; leave out if the meeting is not about code")
  .option("--no-code", "do not look at any code, even if --src or a default is set")
  .option("--each", "every --notes file is a separate meeting of the same project (processed one after another)")
  .option("-f, --force", "process again even if a meeting was already processed")
  .option("--no-review", "generate drafts only; review later with `minion review`")
  .action(async (opts: {
    notes: string[]; meeting?: string; src?: string; code: boolean; each?: boolean; repo?: string; force?: boolean; review: boolean;
  }) => {
    const cfg = config();
    const store = new Store(cfg.stateDir);
    const repo = opts.repo ?? cfg.defaultRepo;
    if (!repo) throw new InputError(['--repo is required (or set "defaultRepo" in minion.config.json).']);
    const srcPath = opts.code ? (opts.src ?? null) : null;
    const progress = (m: string) => process.stderr.write(`• ${m}\n`);
    const agents = geminiFactory(cfg, (a) => process.stderr.write(`    ↳ ${a}\n`));

    // One meeting per file (--each), or all files together as one meeting (notes + transcript).
    const groups = opts.each ? opts.notes.map((f) => [f]) : [opts.notes];
    if (opts.each && opts.meeting) console.log("Note: --meeting is ignored with --each; titles come from the file names.");
    const recaps: { title: string; file: string }[] = [];

    for (const [i, files] of groups.entries()) {
      const meetingTitle = (!opts.each && opts.meeting) || meetingTitleFromFile(files[0]!);
      if (groups.length > 1) console.log(`\n=== Meeting ${i + 1}/${groups.length}: ${meetingTitle} ===`);
      let run;
      try {
        run = await generate(
          { notes: await readNotesFiles(files), srcPath, meetingTitle, repo, force: opts.force },
          { agents, store, config: cfg, onProgress: progress },
        );
      } catch (e) {
        if (groups.length > 1 && e instanceof MeetingAlreadyProcessedError) {
          console.log(`Skipped: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }
      if (!opts.review && run.drafts.length > 0) {
        console.log(`Drafts are waiting for review: minion review ${run.meetingId}`);
        continue;
      }
      if (run.drafts.length === 0) console.log("No decided action items found.");
      const decisions = run.drafts.length ? await reviewInTerminal(run, await store.loadLedger()) : {};
      const result = await finalize(run, decisions, { store, config: cfg });
      printResult(result);
      if (result.recap) recaps.push({ title: run.meetingTitle, file: result.recap });
    }

    if (recaps.length > 1) {
      const combined = path.join(cfg.outDir, `combined-recap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
      const parts = await Promise.all(recaps.map((r) => readFile(r.file, "utf8")));
      await mkdir(cfg.outDir, { recursive: true });
      await writeFile(combined, parts.map((p) => p.trim()).join("\n\n----------------------------------------\n\n") + "\n", "utf8");
      console.log(`\nCombined recap of all ${recaps.length} meetings: ${combined}`);
    }
  });

program
  .command("review [meetingId]")
  .description("review drafts that are waiting (lists them when no id is given)")
  .action(async (meetingId?: string) => {
    const cfg = config();
    const store = new Store(cfg.stateDir);
    if (!meetingId) {
      const pending = await store.listPending();
      if (!pending.length) return console.log("Nothing is waiting for review.");
      for (const p of pending) console.log(`${p.meetingId}\t${p.drafts.length} draft(s)\t${p.createdAt}`);
      return;
    }
    const run = await store.loadPending(meetingId);
    const decisions = await reviewInTerminal(run, await store.loadLedger());
    printResult(await finalize(run, decisions, { store, config: cfg }));
  });

/** Open a URL in the default browser (Windows, macOS, Linux). */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

program
  .command("web")
  .description("open the local web form (input form + review table)")
  .option("-p, --port <port>", "port (default 4711)")
  .option("--open", "also open it in the default browser")
  .action(async (opts: { port?: string; open?: boolean }) => {
    const cfg = config();
    const port = opts.port ? Number(opts.port) : cfg.webPort;
    try {
      const { url } = await startWebServer({ config: cfg, port, agents: (onActivity) => geminiFactory(cfg, onActivity) });
      console.log(`Atef's Minion web form: ${url}  (keep this window open; Ctrl+C to stop)`);
      if (opts.open) openBrowser(url);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      const url = `http://127.0.0.1:${port}/`;
      const running = await fetch(`${url}api/info`).then((r) => r.ok).catch(() => false);
      if (!running) throw new Error(`Port ${port} is used by another program. Try: minion web --port 4800`);
      console.log(`Atef's Minion is already running: ${url}`);
      if (opts.open) openBrowser(url);
    }
  });

program
  .command("recap <meetingId>")
  .description("print the ready-to-send meeting recap (decisions, actions, owners, tickets)")
  .action(async (meetingId: string) => {
    const recap = await readRecap(new Store(config().stateDir), meetingId);
    if (!recap) throw new Error(`No recap for "${meetingId}": nothing was approved or merged in that meeting.`);
    console.log(recap);
  });

program
  .command("link <draftId> <issueUrl>")
  .description("record the GitHub issue created for a draft; recaps and index pages then show the link")
  .action(async (draftId: string, issueUrl: string) => {
    const r = await linkIssue(new Store(config().stateDir), draftId, issueUrl);
    console.log(`Linked "${r.title}" to ${issueUrl}.${r.meetings.length ? ` Updated recap of ${r.meetings.join(", ")}.` : ""}`);
  });

const ledgerCmd = program.command("ledger").description("inspect processed meetings and drafts");
ledgerCmd
  .command("list")
  .description("list processed meetings")
  .action(async () => {
    const ledger = await new Store(config().stateDir).loadLedger();
    const meetings = Object.entries(ledger.meetings).sort((a, b) => b[1].processedAt.localeCompare(a[1].processedAt));
    if (!meetings.length) return console.log("The ledger is empty.");
    for (const [id, m] of meetings) {
      console.log(`${id}  (${m.repo}, ${m.processedAt.slice(0, 10)})`);
      for (const d of m.drafts) {
        const draft = ledger.drafts[d];
        console.log(`   ${d}  ${draft?.content.title ?? "?"}${draft?.issueUrl ? `  -> ${draft.issueUrl}` : ""}`);
      }
    }
  });
ledgerCmd
  .command("show <id>")
  .description("show a meeting or a draft by id")
  .action(async (id: string) => {
    const ledger = await new Store(config().stateDir).loadLedger();
    const found = ledger.meetings[id] ?? ledger.drafts[id];
    if (!found) throw new Error(`No meeting or draft with id "${id}".`);
    console.log(JSON.stringify(found, null, 2));
  });

ledgerCmd
  .command("remove <draftId>")
  .description("remove a draft created by mistake (deletes its file and forgets it for duplicate checks)")
  .option("-y, --yes", "do not ask for confirmation")
  .action(async (draftId: string, opts: { yes?: boolean }) => {
    const store = new Store(config().stateDir);
    const draft = (await store.loadLedger()).drafts[draftId];
    if (!draft) throw new Error(`No draft with id "${draftId}". See "minion ledger list".`);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error("Add --yes to confirm when not running in a terminal.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`Remove draft ${draftId} "${draft.content.title}"${draft.file ? ` and delete ${draft.file}` : ""}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== "y") return console.log("Nothing removed.");
    }
    const removed = await removeDraft(store, draftId);
    console.log(`Removed "${removed.title}"${removed.file ? ` (${removed.file})` : ""}.`);
  });

program.parseAsync().catch((e: unknown) => {
  const err = e as Error;
  if (err instanceof InputError) {
    console.error("Invalid input:\n" + err.problems.map((p) => `  - ${p}`).join("\n"));
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exitCode = 1;
});
