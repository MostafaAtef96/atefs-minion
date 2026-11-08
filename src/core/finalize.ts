import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MinionConfig } from "./config.js";
import { newIssueLink, renderIndexPage } from "./export.js";
import { AGENT_LABEL, AGENT_NAME, renderDraftFile, renderIssueBody } from "./render.js";
import type { Draft, Ledger, MergeAdditions, PendingRun, ReviewDecision, TicketContent, VerifiedRef } from "./schemas.js";
import type { Store } from "./store.js";
import { writeAtomic } from "./store.js";
import { fingerprint, normalizeItem, slugify } from "./text.js";

export type ListField = "inScope" | "outOfScope" | "dependencies" | "acceptanceCriteria" | "deliverables";
export const LIST_FIELDS: ListField[] = ["inScope", "outOfScope", "dependencies", "acceptanceCriteria", "deliverables"];
export const FIELD_LABELS: Record<ListField, string> = {
  inScope: "In Scope",
  outOfScope: "Out of Scope",
  dependencies: "Dependencies",
  acceptanceCriteria: "Acceptance Criteria",
  deliverables: "Deliverable",
};

/** Details of a repeated action that the existing draft does not contain yet. */
export interface MergeCandidates {
  lists: Partial<Record<ListField, string[]>>;
  /** Code references whose lines do not overlap a reference already on the draft. */
  refs: VerifiedRef[];
  count: number;
}

function overlaps(a: VerifiedRef, b: VerifiedRef): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export function mergeCandidates(existing: Draft, incoming: Draft): MergeCandidates {
  const lists: MergeCandidates["lists"] = {};
  let count = 0;
  for (const field of LIST_FIELDS) {
    const known = new Set(existing.content[field].map(normalizeItem));
    const added = [...new Set(incoming.content[field])].filter((item) => !known.has(normalizeItem(item)));
    if (added.length) {
      lists[field] = added;
      count += added.length;
    }
  }
  const refs = incoming.refs.filter((r) => !existing.refs.some((e) => overlaps(e, r)));
  return { lists, refs, count: count + refs.length };
}

export interface MergeResult {
  merged: Draft;
  candidates: MergeCandidates;
}

/**
 * Merge a repeated action into the existing draft. The new meeting and its quotes are always added;
 * other new details only when the reviewer selected them (`additions`), so tickets do not fill up
 * with re-worded copies of what they already say.
 */
export function mergeDrafts(existing: Draft, incoming: Draft, additions: MergeAdditions = {}): MergeResult {
  const merged: Draft = structuredClone(existing);
  const candidates = mergeCandidates(existing, incoming);

  for (const src of incoming.sources) {
    const same = merged.sources.find((s) => s.meetingId === src.meetingId);
    if (same) {
      const known = new Set(same.quotes.map((q) => normalizeItem(q.text)));
      same.quotes.push(...src.quotes.filter((q) => !known.has(normalizeItem(q.text))));
    } else {
      merged.sources.push(structuredClone(src));
    }
  }
  for (const field of LIST_FIELDS) {
    const chosen = new Set((additions[field] ?? []).map(normalizeItem));
    const add = (candidates.lists[field] ?? []).filter((item) => chosen.has(normalizeItem(item)));
    merged.content[field] = [...merged.content[field], ...add];
  }
  const chosenRefs = new Set(additions.refs ?? []);
  merged.refs.push(...candidates.refs.filter((r) => chosenRefs.has(r.permalink)));
  merged.owner = merged.owner ?? incoming.owner;
  merged.due = merged.due ?? incoming.due;
  return { merged, candidates };
}

/** Select every candidate (used by "add all"). */
export function allAdditions(c: MergeCandidates): MergeAdditions {
  return { ...c.lists, refs: c.refs.map((r) => r.permalink) };
}

export interface FinalizeResult {
  outDir: string | null;
  written: { draftId: string; file: string; title: string; issueUrl: string; issueUrlComplete: boolean; body: string }[];
  /** out/<meeting>/index.html with "Open as GitHub issue" buttons (null when nothing was written). */
  indexPage: string | null;
  merged: { draftId: string; into: string; file: string | null }[];
  rejected: string[];
}

/**
 * Step 8: apply review decisions — write approved drafts + manifest to out/<meeting-id>/,
 * update merged drafts, record everything in the ledger and clear the pending run.
 */
export async function finalize(
  run: PendingRun,
  decisions: Record<string, ReviewDecision>,
  deps: { store: Store; config: MinionConfig },
): Promise<FinalizeResult> {
  const missing = run.drafts.filter((d) => !decisions[d.draft.id]);
  if (missing.length) {
    throw new Error(`No review decision for: ${missing.map((d) => d.draft.content.title).join(", ")}`);
  }
  const ledger = await deps.store.loadLedger();
  const outDir = path.join(deps.config.outDir, run.meetingId);
  const result: FinalizeResult = { outDir: null, written: [], merged: [], rejected: [], indexPage: null };
  // A forced re-run of a meeting keeps the drafts approved earlier and continues the numbering.
  const previous = ledger.meetings[run.meetingId];
  const meetingDraftIds: string[] = [...(previous?.drafts ?? [])];
  const touchedMeetings = new Set<string>();

  const approved = run.drafts.filter((d) => decisions[d.draft.id]!.action === "approve");
  let index = await highestIndex(outDir);
  for (const { draft } of run.drafts) {
    const decision = decisions[draft.id]!;
    if (decision.action === "reject") {
      result.rejected.push(draft.content.title);
    } else if (decision.action === "approve") {
      const content: TicketContent = decision.content ?? draft.content;
      index += 1;
      const file = path.join(outDir, `${String(index).padStart(2, "0")}-${slugify(content.title, 50)}.md`);
      const final: Draft = { ...draft, content, fingerprint: fingerprint(draft.repo, content.title), file };
      await mkdir(outDir, { recursive: true });
      await writeFile(file, renderDraftFile(final), "utf8");
      ledger.drafts[final.id] = final;
      meetingDraftIds.push(final.id);
      const link = newIssueLink(final);
      result.written.push({ draftId: final.id, file, title: content.title, issueUrl: link.url, issueUrlComplete: link.complete, body: link.body });
    } else {
      const target = ledger.drafts[decision.into];
      if (!target) throw new Error(`Cannot merge "${draft.content.title}": draft ${decision.into} is not in the ledger.`);
      const { merged } = mergeDrafts(target, draft, decision.additions);
      ledger.drafts[merged.id] = merged;
      if (merged.file && existsSync(path.dirname(merged.file))) {
        await writeFile(merged.file, renderDraftFile(merged), "utf8");
      }
      for (const m of Object.entries(ledger.meetings)) if (m[1].drafts.includes(merged.id)) touchedMeetings.add(m[0]);
      result.merged.push({ draftId: draft.id, into: merged.id, file: merged.file ?? null });
    }
  }

  ledger.meetings[run.meetingId] = {
    title: run.meetingTitle,
    repo: run.repo,
    inputHash: run.inputHash,
    processedAt: new Date().toISOString(),
    outDir: approved.length || previous?.outDir ? outDir : "",
    drafts: meetingDraftIds,
  };

  if (approved.length) {
    result.outDir = outDir;
    await writeManifest(ledger, run.meetingId, {
      skipped: run.skipped.map((s) => s.title),
      rejected: result.rejected,
      mergedInto: result.merged.map((m) => ({ title: run.drafts.find((d) => d.draft.id === m.draftId)!.draft.content.title, into: m.into })),
      commitSha: run.commitSha,
    });
    result.indexPage = path.join(outDir, "index.html");
    const log = deps.store.pendingLogFile(run.meetingId);
    if (deps.config.logPrompts && existsSync(log)) await copyFile(log, path.join(outDir, "run.log"));
  }
  for (const m of touchedMeetings) if (m !== run.meetingId || !approved.length) await writeManifest(ledger, m);

  await deps.store.saveLedger(ledger);
  await deps.store.deletePending(run.meetingId);
  return result;
}

async function highestIndex(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const numbers = (await readdir(dir)).map((f) => /^(\d+)-.*\.md$/.exec(f)?.[1]).filter(Boolean).map(Number);
  return numbers.length ? Math.max(...numbers) : 0;
}

interface ManifestExtras {
  skipped?: string[];
  rejected?: string[];
  mergedInto?: { title: string; into: string }[];
  commitSha?: string | null;
}

/** manifest.json — machine-readable input for MVP2 (issue creation). */
export async function writeManifest(ledger: Ledger, meetingId: string, extras: ManifestExtras = {}): Promise<void> {
  const meeting = ledger.meetings[meetingId];
  if (!meeting?.outDir || !existsSync(meeting.outDir)) return;
  const file = path.join(meeting.outDir, "manifest.json");
  let previous: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      previous = JSON.parse(await readFile(file, "utf8"));
    } catch {
      previous = {};
    }
  }
  const drafts = meeting.drafts
    .map((id) => ledger.drafts[id])
    .filter((d): d is Draft => Boolean(d))
    .map((d) => ({
      draftId: d.id,
      file: d.file ? path.basename(d.file) : null,
      issue: { title: d.content.title, body: renderIssueBody(d), labels: [AGENT_LABEL] },
      type: d.content.type,
      fingerprint: d.fingerprint,
      meetings: d.sources.map((s) => s.meetingId),
      draft: d,
    }));
  const manifest = {
    version: 1,
    agent: AGENT_NAME,
    meetingId,
    meetingTitle: meeting.title,
    repo: meeting.repo,
    commitSha: extras.commitSha ?? previous["commitSha"] ?? null,
    processedAt: meeting.processedAt,
    updatedAt: new Date().toISOString(),
    drafts,
    mergedInto: extras.mergedInto ?? previous["mergedInto"] ?? [],
    rejected: extras.rejected ?? previous["rejected"] ?? [],
    skipped: extras.skipped ?? previous["skipped"] ?? [],
  };
  await writeAtomic(file, JSON.stringify(manifest, null, 2));
  const live = meeting.drafts.map((id) => ledger.drafts[id]).filter((d): d is Draft => Boolean(d));
  await writeAtomic(path.join(meeting.outDir, "index.html"), renderIndexPage(meeting.title, meeting.repo, live));
}

/** Remove a draft created by mistake: deletes it from the ledger and its meeting, deletes its file, rewrites the manifest. */
export async function removeDraft(store: Store, draftId: string): Promise<{ title: string; file: string | null }> {
  const ledger = await store.loadLedger();
  const draft = ledger.drafts[draftId];
  if (!draft) throw new Error(`No draft with id "${draftId}". See "minion ledger list".`);
  delete ledger.drafts[draftId];
  const meetings = Object.entries(ledger.meetings).filter(([, m]) => m.drafts.includes(draftId));
  for (const [, m] of meetings) m.drafts = m.drafts.filter((d) => d !== draftId);
  if (draft.file && existsSync(draft.file)) await rm(draft.file);
  await store.saveLedger(ledger);
  for (const [id] of meetings) await writeManifest(ledger, id);
  return { title: draft.content.title, file: draft.file ?? null };
}
