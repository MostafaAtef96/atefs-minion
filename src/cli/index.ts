#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, type MinionConfig } from "../core/config.js";
import { createInterface } from "node:readline/promises";
import { finalize, removeDraft, type FinalizeResult } from "../core/finalize.js";
import { InputError, readNotesFiles } from "../core/inputs.js";
import { generate } from "../core/pipeline.js";
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
  for (const w of r.written) console.log(`✅ ${w.title}\n   ${w.file}`);
  for (const m of r.merged) console.log(`🔁 merged into draft ${m.into}${m.file ? `\n   ${m.file}` : ""}`);
  for (const t of r.rejected) console.log(`✖ rejected: ${t}`);
  if (r.outDir) console.log(`\nDrafts and manifest: ${r.outDir}`);
}

program
  .command("run")
  .description("extract actions from meeting notes, draft tickets, and review them")
  .requiredOption("-n, --notes <files...>", "Gemini notes and/or transcript (.md or .txt)")
  .requiredOption("-m, --meeting <title>", 'meeting title, e.g. "Sprint Review 2026-11-05"')
  .option("-s, --src <path>", "local git clone of the target repository", ".")
  .option("-r, --repo <owner/name>", "GitHub repository the tickets are for")
  .option("-f, --force", "process again even if this meeting was already processed")
  .option("--no-review", "generate drafts only; review later with `minion review`")
  .action(async (opts: { notes: string[]; meeting: string; src: string; repo?: string; force?: boolean; review: boolean }) => {
    const cfg = config();
    const store = new Store(cfg.stateDir);
    const repo = opts.repo ?? cfg.defaultRepo;
    if (!repo) throw new InputError(['--repo is required (or set "defaultRepo" in minion.config.json).']);
    const progress = (m: string) => process.stderr.write(`• ${m}\n`);
    const run = await generate(
      { notes: await readNotesFiles(opts.notes), srcPath: opts.src, meetingTitle: opts.meeting, repo, force: opts.force },
      { agents: geminiFactory(cfg, (a) => process.stderr.write(`    ↳ ${a}\n`)), store, config: cfg, onProgress: progress },
    );
    if (!opts.review || run.drafts.length === 0) {
      if (run.drafts.length === 0) {
        console.log("No decided action items found.");
        printResult(await finalize(run, {}, { store, config: cfg }));
      } else {
        console.log(`Drafts are waiting for review: minion review ${run.meetingId}`);
      }
      return;
    }
    const decisions = await reviewInTerminal(run, await store.loadLedger());
    printResult(await finalize(run, decisions, { store, config: cfg }));
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

program
  .command("web")
  .description("open the local web form (input form + review table)")
  .option("-p, --port <port>", "port (default 4711)")
  .action(async (opts: { port?: string }) => {
    const cfg = config();
    const port = opts.port ? Number(opts.port) : cfg.webPort;
    const { url } = await startWebServer({ config: cfg, port, agents: (onActivity) => geminiFactory(cfg, onActivity) });
    console.log(`Atef's Minion web form: ${url}  (Ctrl+C to stop)`);
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
      for (const d of m.drafts) console.log(`   ${d}  ${ledger.drafts[d]?.content.title ?? "?"}`);
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
