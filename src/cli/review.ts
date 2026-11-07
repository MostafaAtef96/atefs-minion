import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { mergeDrafts } from "../core/finalize.js";
import { parseEditable, renderDraftFile, renderEditable } from "../core/render.js";
import type { Ledger, PendingDraft, PendingRun, ReviewDecision, TicketContent } from "../core/schemas.js";

const RULE = "─".repeat(72);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** Open the ticket in $VISUAL/$EDITOR (Notepad on Windows) and parse it back. */
export async function editInEditor(content: TicketContent): Promise<TicketContent> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "minion-"));
  const file = path.join(dir, "ticket.md");
  await writeFile(file, renderEditable(content), "utf8");
  const editor = process.env["VISUAL"] || process.env["EDITOR"] || (process.platform === "win32" ? "notepad" : "vi");
  try {
    for (;;) {
      const res = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
      if (res.status !== 0) throw new Error(`Editor "${editor}" exited with code ${res.status}.`);
      try {
        return parseEditable(await readFile(file, "utf8"));
      } catch (e) {
        console.log(`\nCould not read the edited ticket: ${(e as Error).message}`);
        if ((await ask("Edit again? [Y/n] ")) === "n") return content;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function describeDuplicate(p: PendingDraft, ledger: Ledger): string[] {
  if (p.dedup.status !== "duplicate" || !p.dedup.duplicateOf) return [];
  const target = ledger.drafts[p.dedup.duplicateOf];
  if (!target) return [];
  const lines = [
    `🔁 Possible duplicate (${p.dedup.layer}) of draft ${target.id}: "${target.content.title}"`,
    `   raised in: ${target.sources.map((s) => s.meetingTitle).join(", ")}`,
  ];
  if (p.dedup.reason) lines.push(`   reason: ${p.dedup.reason}`);
  const { additions, newRefs } = mergeDrafts(target, p.draft);
  const added = Object.entries(additions).map(([k, v]) => `${k} +${v!.length}`);
  lines.push(`   merging adds this meeting as a source${added.length ? `, plus ${added.join(", ")}` : ""}${newRefs ? `, +${newRefs} code ref(s)` : ""}.`);
  return lines;
}

/** Interactive terminal review (plan §6 step 7). Returns one decision per draft. */
export async function reviewInTerminal(run: PendingRun, ledger: Ledger): Promise<Record<string, ReviewDecision>> {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive review needs a terminal. Use "minion web" to review in the browser.');
  }
  console.log(`\n${RULE}\nReview: ${run.meetingTitle} → ${run.repo}  (${run.drafts.length} draft(s))\n${RULE}`);
  for (const w of run.warnings) console.log(`⚠️  ${w}`);
  if (run.skipped.length) {
    console.log("\nNot drafted (discussion only):");
    for (const s of run.skipped) console.log(`  • ${s.title}`);
  }

  const decisions: Record<string, ReviewDecision> = {};
  for (const [i, p] of run.drafts.entries()) {
    let content = p.draft.content;
    for (;;) {
      console.log(`\n${RULE}\nDraft ${i + 1}/${run.drafts.length}\n${RULE}`);
      console.log(renderDraftFile({ ...p.draft, content }));
      const dup = describeDuplicate(p, ledger);
      for (const l of dup) console.log(l);
      const canMerge = dup.length > 0;
      const options = `[a]pprove  [e]dit  [t]ype → ${content.type === "Task" ? "UserStory" : "Task"}  [r]eject${canMerge ? "  [m]erge" : ""}`;
      const def = canMerge ? "m" : "a";
      const answer = (await ask(`\n${options}  (default ${def}): `)) || def;
      if (answer === "a") {
        decisions[p.draft.id] = { action: "approve", content };
        break;
      } else if (answer === "r") {
        decisions[p.draft.id] = { action: "reject" };
        break;
      } else if (answer === "m" && canMerge) {
        decisions[p.draft.id] = { action: "merge", into: p.dedup.duplicateOf! };
        break;
      } else if (answer === "e") {
        content = await editInEditor(content);
      } else if (answer === "t") {
        content = { ...content, type: content.type === "Task" ? "UserStory" : "Task" };
      } else {
        console.log("Unknown choice.");
      }
    }
  }
  return decisions;
}
