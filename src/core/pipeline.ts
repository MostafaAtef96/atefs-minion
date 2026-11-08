import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askJson, StructuredOutputError } from "../control/json.js";
import type { AgentFactory, AgentSession } from "../control/session.js";
import type { MinionConfig } from "./config.js";
import { DOD_CRITERIA } from "./dod.js";
import { listTrackedFiles, originMatchesRepo, readGitInfo } from "./git.js";
import { validateInputs, type RunInputs } from "./inputs.js";
import { renderPrompt } from "./prompts.js";
import { verifyRefs } from "./refs.js";
import {
  P1Output,
  P2Output,
  P3Output,
  P4Output,
  type DedupProposal,
  type Draft,
  type ExtractedAction,
  type Ledger,
  type PendingDraft,
  type PendingRun,
  type SkippedAction,
  type TicketContent,
  type VerifiedRef,
} from "./schemas.js";
import type { Store } from "./store.js";
import { fingerprint, shortId } from "./text.js";

export const LOW_CONFIDENCE = 0.5;
export const DEDUP_MIN_CONFIDENCE = 0.5;

export interface PipelineDeps {
  agents: AgentFactory;
  store: Store;
  config: MinionConfig;
  onProgress?: (message: string) => void;
}

export class MeetingAlreadyProcessedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingAlreadyProcessedError";
  }
}

function formatNotes(notes: { name: string; content: string }[]): string {
  return notes
    .map((n) => `<file name="${n.name.replace(/"/g, "'")}">\n${n.content.trim()}\n</file>`)
    .join("\n\n");
}

/** Steps 0–6 of the pipeline (plan §6): produces a pending run that waits for review. */
export async function generate(rawInputs: RunInputs, deps: PipelineDeps): Promise<PendingRun> {
  const { store, config } = deps;
  const progress = deps.onProgress ?? (() => {});
  const inputs = await validateInputs(rawInputs);
  const { meetingId, repo, srcPath } = inputs;
  const warnings: string[] = [];

  // ---- Step 0: pre-checks (L1) ---------------------------------------------------------
  const ledger = await store.loadLedger();
  if (!inputs.force) {
    const prev = ledger.meetings[meetingId];
    if (prev) {
      throw new MeetingAlreadyProcessedError(
        `Meeting "${meetingId}" was already processed on ${prev.processedAt}. Use --force (or tick “process again” in the web form) to process it again.`,
      );
    }
    const sameInput = Object.entries(ledger.meetings).find(([, m]) => m.inputHash === inputs.inputHash);
    if (sameInput) {
      throw new MeetingAlreadyProcessedError(
        `These notes were already processed as meeting "${sameInput[0]}". Use --force (or tick “process again” in the web form) to process them again.`,
      );
    }
    if (existsSync(store.pendingFile(meetingId))) {
      throw new MeetingAlreadyProcessedError(
        `Drafts for "${meetingId}" are waiting for review. Run "minion review ${meetingId}", or use --force (“process again” in the web form) to regenerate them.`,
      );
    }
  }

  const git = await readGitInfo(srcPath);
  if (!git.isRepo) {
    warnings.push("Source path is not a git repository: code references are disabled (no permalinks possible).");
  } else {
    if (git.dirty) warnings.push("Source repository has uncommitted changes: line references may not match the commit.");
    if (!git.onRemote) warnings.push("HEAD commit is not on any remote branch or tag: permalinks may not resolve on GitHub.");
    if (git.originUrl && !originMatchesRepo(git.originUrl, repo)) {
      warnings.push(`The clone's origin (${git.originUrl}) does not match ${repo}: permalinks point to ${repo}.`);
    }
  }
  const tracked = git.isRepo ? await listTrackedFiles(srcPath) : new Set<string>();
  const sha = git.headSha;

  // Prompt log (moved into out/<meeting>/run.log on approval).
  const logFile = store.pendingLogFile(meetingId);
  await mkdir(path.dirname(logFile), { recursive: true });
  await rm(logFile, { force: true });
  let logChain = Promise.resolve();
  const log = (role: string, text: string) => {
    if (!config.logPrompts) return;
    const entry = `\n===== ${new Date().toISOString()} ${role.toUpperCase()} =====\n${text}\n`;
    logChain = logChain.then(() => appendFile(logFile, entry, "utf8")).catch(() => {});
  };
  for (const w of warnings) log("warning", w);

  // ---- Step 1: init -------------------------------------------------------------------
  progress("Starting Gemini CLI…");
  const startedAt = Date.now();
  const session = await deps.agents.open(srcPath, { onEvent: (text) => log("event", text) });
  // Every turn (including retries after invalid JSON) is logged with its task label.
  const ask = <S extends z.ZodType>(prompt: string, schema: S, label: string) =>
    askJson(loggingSession(session, label, log), prompt, schema, config.maxRetries);

  const drafts: PendingDraft[] = [];
  const skipped: SkippedAction[] = [];
  try {
    await loggingSession(session, "system", log).prompt(renderPrompt("system", { repo }));

    // ---- Step 2: extract ------------------------------------------------------------------
    progress("Extracting action items…");
    const p1 = await ask(
      renderPrompt("p1-extract", {
        meetingTitle: inputs.meetingTitle,
        repo,
        fileCount: inputs.notes.length,
        notes: formatNotes(inputs.notes),
      }),
      P1Output,
      "P1",
    );
    const decided = p1.actions.filter((a) => a.decided);
    for (const a of p1.actions.filter((x) => !x.decided)) {
      skipped.push({ title: a.title, reason: "Not decided in the meeting (discussion only)", quotes: a.quotes });
    }
    progress(`Found ${decided.length} decided action(s), ${skipped.length} discussion-only item(s).`);

    const candidates = Object.values(ledger.drafts)
      .filter((d) => d.repo.toLowerCase() === repo.toLowerCase())
      .slice(-config.dedupMaxCandidates);

    for (const [i, action] of decided.entries()) {
      const label = `[${i + 1}/${decided.length}] ${action.title}`;

      // ---- Steps 3–4: code context + verification ----------------------------------------
      let refs: VerifiedRef[] = [];
      const flags: string[] = [];
      if (git.isRepo) {
        progress(`${label}: searching related code…`);
        try {
          const p2 = await ask(renderPrompt("p2-code", { title: action.title, summary: action.summary }), P2Output, "P2");
          const checked = await verifyRefs({ refs: p2.refs, srcPath, repo, sha, tracked });
          refs = checked.verified;
          for (const d of checked.dropped) log("dropped ref", `${d.ref.path}:${d.ref.startLine}-${d.ref.endLine} — ${d.reason}`);
          for (const a of checked.adjusted) log("adjusted ref", `${a.ref.path}:${a.ref.startLine}-${a.ref.endLine} — ${a.reason}`);
        } catch (e) {
          if (!(e instanceof StructuredOutputError)) throw e;
          flags.push("Code search failed; related code was not added.");
        }
      }

      // ---- Step 5: draft ----------------------------------------------------------------------
      progress(`${label}: drafting ticket…`);
      let content: TicketContent;
      try {
        content = await ask(
          renderPrompt("p3-draft", {
            meetingTitle: inputs.meetingTitle,
            action: JSON.stringify(action, null, 2),
            refs: refs.length
              ? refs.map((r) => `- ${r.path} L${r.startLine}-L${r.endLine}${r.symbol ? ` (${r.symbol})` : ""}: ${r.why}`).join("\n")
              : "(none found)",
            dodList: DOD_CRITERIA.map((c, n) => `  ${n + 1}. ${c}`).join("\n"),
          }),
          P3Output,
          "P3",
        );
      } catch (e) {
        if (!(e instanceof StructuredOutputError)) throw e;
        content = fallbackContent(action);
        flags.push("Automatic drafting failed; sections must be completed manually.");
      }

      if (action.otherTarget) flags.push(`This action may belong to ${action.otherTarget} rather than ${repo}.`);
      if (action.confidence < LOW_CONFIDENCE) flags.push(`Low confidence (${action.confidence}) that this was a decided action.`);

      const draft: Draft = {
        id: shortId(),
        repo,
        commitSha: sha,
        content,
        owner: action.owner ?? null,
        due: action.due ?? null,
        sources: [{ meetingId, meetingTitle: inputs.meetingTitle, quotes: action.quotes }],
        refs,
        fingerprint: fingerprint(repo, content.title),
        flags,
        file: null,
      };

      // ---- Step 6: de-duplication (L2, L3) ---------------------------------------------------
      const dedup = await checkDuplicate(draft, candidates, ledger, async (prompt) => {
        progress(`${label}: checking for duplicates…`);
        return ask(prompt, P4Output, "P4");
      }, inputs.meetingTitle).catch((e) => {
        if (!(e instanceof StructuredOutputError)) throw e;
        flags.push("Duplicate check failed; please check manually for existing drafts.");
        return { status: "new" } as DedupProposal;
      });
      drafts.push({ draft, dedup });
    }
  } finally {
    await session.close().catch(() => {});
    log("summary", `Finished in ${formatDuration(Date.now() - startedAt)}: ${drafts.length} draft(s), ${skipped.length} not drafted.`);
    await logChain;
  }

  const run: PendingRun = {
    version: 1,
    meetingId,
    meetingTitle: inputs.meetingTitle,
    repo,
    srcPath,
    commitSha: sha,
    inputHash: inputs.inputHash,
    createdAt: new Date().toISOString(),
    drafts,
    skipped,
    warnings,
  };
  await store.savePending(run);
  progress(`${drafts.length} draft(s) ready for review (${formatDuration(Date.now() - startedAt)}).`);
  return run;
}

function loggingSession(session: AgentSession, label: string, log: (role: string, text: string) => void): AgentSession {
  let turn = 0;
  return {
    prompt: async (text) => {
      turn += 1;
      const tag = turn === 1 ? label : `${label} (retry ${turn - 1})`;
      log(`prompt ${tag}`, text);
      const reply = await session.prompt(text);
      log(`response ${tag}`, reply);
      return reply;
    },
    close: () => session.close(),
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function fallbackContent(action: ExtractedAction): TicketContent {
  return {
    title: action.title,
    type: action.type,
    objective: "",
    inScope: [],
    outOfScope: [],
    dependencies: [],
    acceptanceCriteria: [],
    dod: [],
    deliverables: [],
  };
}

/** L2 exact fingerprint, then L3 semantic comparison by Gemini (P4). */
export async function checkDuplicate(
  draft: Draft,
  candidates: Draft[],
  ledger: Ledger,
  askP4: (prompt: string) => Promise<z.infer<typeof P4Output>>,
  meetingTitle: string,
): Promise<DedupProposal> {
  const exact = candidates.find((c) => c.fingerprint === draft.fingerprint);
  if (exact) {
    return {
      status: "duplicate",
      duplicateOf: exact.id,
      layer: "L2",
      reason: `Same title as "${exact.content.title}" (${exact.sources.map((s) => s.meetingTitle).join(", ")}).`,
    };
  }
  if (candidates.length === 0) return { status: "new" };
  const p4 = await askP4(
    renderPrompt("p4-dedup", {
      meetingTitle,
      newDraft: JSON.stringify(summarize(draft), null, 2),
      candidates: JSON.stringify(candidates.map(summarize), null, 2),
    }),
  );
  if (p4.duplicateOf && ledger.drafts[p4.duplicateOf] && p4.confidence >= DEDUP_MIN_CONFIDENCE) {
    return { status: "duplicate", duplicateOf: p4.duplicateOf, layer: "L3", reason: p4.reason };
  }
  return { status: "new", reason: p4.duplicateOf ? `Possible match ignored (low confidence): ${p4.reason}` : null };
}

function summarize(d: Draft) {
  return {
    id: d.id,
    title: d.content.title,
    type: d.content.type,
    objective: d.content.objective,
    inScope: d.content.inScope,
    meetings: d.sources.map((s) => s.meetingTitle),
  };
}
