import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { FIELD_LABELS, LIST_FIELDS, mergeCandidates, type ListField } from "../core/finalize.js";
import { parseEditable, renderDraftFile, renderEditable } from "../core/render.js";
import type { Draft, Ledger, MergeAdditions, PendingDraft, PendingRun, ReviewDecision, TicketContent } from "../core/schemas.js";

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

/** Hide what only matters on GitHub (signature image tag, hidden metadata comment) when showing a draft in the terminal. */
export function forTerminal(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->\n?/g, "").replace(/<img [^>]*> ?/g, "").trimEnd();
}

function describeDuplicate(p: PendingDraft, ledger: Ledger): string[] {
  if (p.dedup.status !== "duplicate" || !p.dedup.duplicateOf) return [];
  const target = ledger.drafts[p.dedup.duplicateOf];
  if (!target) return [];
  const lines = [
    `Already ticketed (${p.dedup.layer === "L2" ? "same title" : "same work, found by Gemini"}): "${target.content.title}" [${target.id}]`,
    `   raised in: ${target.sources.map((s) => s.meetingTitle).join(", ")}`,
  ];
  if (p.dedup.reason && p.dedup.layer !== "L2") lines.push(`   reason: ${p.dedup.reason}`);
  const { count } = mergeCandidates(target, p.draft);
  lines.push(
    `   Recommended: [m]erge. This meeting is added to the existing ticket as a source${count ? `; you can pick from ${count} new detail(s)` : ""}.`,
  );
  return lines;
}

/** Let the reviewer pick which new details a merge adds (default: none). */
async function chooseAdditions(target: Draft, incoming: Draft): Promise<MergeAdditions> {
  const c = mergeCandidates(target, incoming);
  if (c.count === 0) return {};
  const items: { label: string; field: ListField | "refs"; value: string }[] = [];
  for (const field of LIST_FIELDS) {
    for (const v of c.lists[field] ?? []) items.push({ label: `[${FIELD_LABELS[field]}] ${v}`, field, value: v });
  }
  for (const r of c.refs) {
    items.push({ label: `[Related code] ${r.path}#L${r.startLine}-L${r.endLine}${r.symbol ? ` (${r.symbol})` : ""}: ${r.why}`, field: "refs", value: r.permalink });
  }
  console.log("\nNew details from this meeting that the existing ticket does not contain word for word:");
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${it.label}`));
  for (;;) {
    const answer = await ask("Add which? [Enter] none · a = all · numbers, e.g. 1,3: ");
    let picked: number[];
    if (!answer) picked = [];
    else if (answer === "a") picked = items.map((_, i) => i);
    else picked = answer.split(/[\s,]+/).filter(Boolean).map((n) => Number(n) - 1);
    if (picked.some((n) => !Number.isInteger(n) || n < 0 || n >= items.length)) {
      console.log("Please enter numbers from the list, 'a', or nothing.");
      continue;
    }
    const additions: MergeAdditions = {};
    for (const n of picked) {
      const it = items[n]!;
      (additions[it.field] ??= []).push(it.value);
    }
    return additions;
  }
}

/** Interactive terminal review (plan §6 step 7). Returns one decision per draft. */
export async function reviewInTerminal(run: PendingRun, ledger: Ledger): Promise<Record<string, ReviewDecision>> {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive review needs a terminal. Use "minion web" to review in the browser.');
  }
  console.log(`\n${RULE}\nReview: ${run.meetingTitle} → ${run.repo}  (${run.drafts.length} draft(s))\n${RULE}`);
  for (const w of run.warnings) console.log(`Warning: ${w}`);
  if (run.skipped.length) {
    console.log("\nNot drafted (discussion only):");
    for (const s of run.skipped) console.log(`  • ${s.title}`);
  }

  const decisions: Record<string, ReviewDecision> = {};
  for (const [i, p] of run.drafts.entries()) {
    let content = p.draft.content;
    const target = p.dedup.status === "duplicate" && p.dedup.duplicateOf ? ledger.drafts[p.dedup.duplicateOf] : undefined;
    for (;;) {
      console.log(`\n${RULE}\nDraft ${i + 1}/${run.drafts.length}\n${RULE}`);
      console.log(forTerminal(renderDraftFile({ ...p.draft, content })));
      if (target) console.log("");
      for (const l of target ? describeDuplicate(p, ledger) : []) console.log(l);
      const toggle = `[t]ype → ${content.type === "Task" ? "UserStory" : "Task"}`;
      const options = target
        ? `[m]erge into existing  [n]ew ticket anyway  [e]dit  ${toggle}  [r]eject`
        : `[a]pprove  [e]dit  ${toggle}  [r]eject`;
      const def = target ? "m" : "a";
      const answer = (await ask(`\n${options}  (default ${def}): `)) || def;
      if (target && answer === "m") {
        decisions[p.draft.id] = { action: "merge", into: target.id, additions: await chooseAdditions(target, { ...p.draft, content }) };
        break;
      } else if ((!target && answer === "a") || (target && (answer === "n" || answer === "a"))) {
        if (target) {
          const sure = await ask(`This work is already ticketed as "${target.content.title}". Create a second ticket anyway? [y/N] `);
          if (sure !== "y") continue;
        }
        decisions[p.draft.id] = { action: "approve", content };
        break;
      } else if (answer === "r") {
        decisions[p.draft.id] = { action: "reject" };
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
