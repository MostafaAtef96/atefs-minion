import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MinionConfig } from "../src/core/config.js";
import { finalize, linkIssue, readRecap, removeDraft } from "../src/core/finalize.js";
import { generate, MeetingAlreadyProcessedError } from "../src/core/pipeline.js";
import type { PendingRun, ReviewDecision } from "../src/core/schemas.js";
import { Store } from "../src/core/store.js";
import { FakeAgentFactory, makeRepo, tempDir, testConfig } from "./helpers.js";
import { sample, scenario } from "./scenario.js";

let root: string;
let repo: string;
let config: MinionConfig;
let store: Store;

beforeEach(async () => {
  root = await tempDir();
  repo = await makeRepo(root);
  config = testConfig(root);
  store = new Store(config.stateDir);
});

async function runMeeting(meetingTitle: string, files: string[], responder = scenario(), force = false) {
  const agents = new FakeAgentFactory(responder);
  const run = await generate(
    { notes: await sample(...files), srcPath: repo, meetingTitle, repo: "tj/commander.js", force },
    { agents, store, config },
  );
  return { run, agents, responder };
}

const approveAll = (run: PendingRun) =>
  Object.fromEntries(run.drafts.map((d) => [d.draft.id, { action: "approve" } as ReviewDecision]));

describe("pipeline on the synthetic samples", () => {
  it("meeting 1: drafts decided actions only, verifies code refs, writes nothing before approval", async () => {
    const { run, agents, responder } = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"]);

    expect(agents.opened).toEqual([repo]);
    expect(agents.closed).toBe(1);
    expect(responder.calls).toMatchObject({ system: 1, P1: 1, P2: 3, P3: 3, P4: 0 });
    expect(run.drafts.map((d) => d.draft.content.title)).toEqual([
      "Mention env variable in missing mandatory option error",
      "Add opt-in JSON help output",
      "Add regression tests for Did-you-mean suggestions",
    ]);
    expect(run.skipped.map((s) => s.title)).toEqual(["Drop Node 20 support"]);
    expect(run.drafts.every((d) => d.dedup.status === "new")).toBe(true);

    const env = run.drafts[0]!.draft;
    expect(env.refs.map((r) => r.path)).toEqual(["lib/command.js"]); // hallucinated ref dropped
    expect(env.refs[0]!.permalink).toMatch(/^https:\/\/github\.com\/tj\/commander\.js\/blob\/[0-9a-f]{40}\/lib\/command\.js#L100-L110$/);
    expect(run.warnings.some((w) => w.includes("not on any remote"))).toBe(true);
    expect(P1PromptContainsNotes(agents.prompts)).toBe(true);

    // review gate: nothing in out/ yet; the run waits in the state dir
    expect(existsSync(config.outDir)).toBe(false);
    expect(existsSync(store.pendingFile(run.meetingId))).toBe(true);

    const decisions = approveAll(run);
    decisions[run.drafts[2]!.draft.id] = { action: "reject" };
    const result = await finalize(run, decisions, { store, config });
    expect(result.written).toHaveLength(2);
    expect(result.rejected).toEqual(["Add regression tests for Did-you-mean suggestions"]);

    const outDir = path.join(config.outDir, "planning-2026-11-03");
    expect((await readdir(outDir)).sort()).toEqual([
      "01-mention-env-variable-in-missing-mandatory-option.md",
      "02-add-opt-in-json-help-output.md",
      "index.html",
      "manifest.json",
      "recap.md",
      "run.log",
    ]);
    const recap = await readFile(path.join(outDir, "recap.md"), "utf8");
    expect(recap).toContain("1. Mention env variable in missing mandatory option error\n   Owner: Lena Hoffmann · Task\n   Ticket: to be created");
    expect(recap).toContain("Discussed, no decision yet:\n- Drop Node 20 support");
    expect(result.recap).toBe(path.join(outDir, "recap.md"));
    const index = await readFile(path.join(outDir, "index.html"), "utf8");
    expect(index.match(/Open as GitHub issue/g)).toHaveLength(2);
    expect(result.written[0]!.issueUrl).toMatch(/^https:\/\/github\.com\/tj\/commander\.js\/issues\/new\?title=Mention/);
    expect(result.indexPage).toBe(path.join(outDir, "index.html"));
    const md = await readFile(result.written[0]!.file, "utf8");
    expect(md).toMatch(/^# Mention env variable in missing mandatory option error/);
    expect(md).toContain('\n---\n<img src="https://raw.githubusercontent.com/MostafaAtef96/atefs-minion/main/assets/minion-signature.png" width="20" height="20" alt="Atef\'s Minion"> Drafted by **Atef\'s Minion**');
    expect(md).toContain("<!-- atefs-minion:v1 ");

    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    expect(manifest.agent).toBe("Atef's Minion");
    expect(manifest.drafts[0].issue.labels).toEqual(["atefs-minion"]);
    expect(manifest.skipped).toEqual(["Drop Node 20 support"]);
    expect(manifest.rejected).toEqual(["Add regression tests for Did-you-mean suggestions"]);

    const log = await readFile(path.join(outDir, "run.log"), "utf8");
    expect(log).toContain("PROMPT P1");
    expect(existsSync(store.pendingFile(run.meetingId))).toBe(false);
  });

  it("L1: refuses to process the same meeting or the same notes twice unless forced", async () => {
    const first = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"]);
    await expect(runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"])).rejects.toThrow(/waiting for review/);
    await finalize(first.run, approveAll(first.run), { store, config });
    await expect(runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"])).rejects.toBeInstanceOf(MeetingAlreadyProcessedError);
    await expect(runMeeting("Planning (renamed)", ["01-planning-2026-11-03.md"])).rejects.toThrow(/already processed as meeting "planning-2026-11-03"/);

    // forced re-run: every action is recognised as an exact duplicate (L2) of the approved drafts
    const again = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"], scenario(), true);
    expect(again.run.drafts.map((d) => [d.dedup.status, d.dedup.layer])).toEqual([
      ["duplicate", "L2"], ["duplicate", "L2"], ["duplicate", "L2"],
    ]);
    expect(again.responder.calls["P4"]).toBe(0);
  });

  it("meeting 2: discussion-only meeting (notes + transcript files) produces no drafts", async () => {
    const { run, agents } = await runMeeting("Grooming 2026-11-10", ["02-grooming-notes.md", "02-grooming-transcript.md"]);
    expect(run.drafts).toEqual([]);
    expect(run.skipped).toHaveLength(3);
    const p1 = agents.prompts.find((p) => p.includes("# Task P1"))!;
    expect(p1).toContain('<file name="02-grooming-notes.md">');
    expect(p1).toContain('<file name="02-grooming-transcript.md">');
    const result = await finalize(run, {}, { store, config });
    expect(result.outDir).toBeNull();
    expect((await store.loadLedger()).meetings["grooming-2026-11-10"]).toBeDefined();
  });

  it("meeting 3: a repeated action is proposed as a merge (L3) and merging updates the original draft", async () => {
    const m1 = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"]);
    const r1 = await finalize(m1.run, approveAll(m1.run), { store, config });
    const original = r1.written[0]!;

    const m3 = await runMeeting("Sprint Review 2026-11-17", ["03-sprint-review-2026-11-17.md"]);
    const [repeated, fresh] = m3.run.drafts;
    expect(repeated!.dedup).toMatchObject({ status: "duplicate", layer: "L3", duplicateOf: original.draftId });
    expect(fresh!.dedup.status).toBe("new");

    const optionRef = repeated!.draft.refs.find((r) => r.path === "lib/option.js")!.permalink;
    const r3 = await finalize(m3.run, {
      [repeated!.draft.id]: { action: "merge", into: original.draftId, additions: { acceptanceCriteria: ["Works for options on parent commands"], refs: [optionRef] } },
      [fresh!.draft.id]: { action: "approve" },
    }, { store, config });
    expect(r3.merged).toEqual([{ draftId: repeated!.draft.id, into: original.draftId, file: original.file }]);
    expect(r3.written.map((w) => w.title)).toEqual(["Reject options that share the same environment variable"]);

    const md = await readFile(original.file, "utf8");
    expect(md).toContain("**Raised in:** Planning 2026-11-03");
    expect(md).toContain("**Raised in:** Sprint Review 2026-11-17");
    expect(md).toContain("Works for options on parent commands"); // picked by the reviewer
    expect(md).not.toContain("Error names the environment variable"); // offered but not picked
    expect(md).toContain('"meetings":["planning-2026-11-03","sprint-review-2026-11-17"]');
    expect(md).toContain("lib/option.js#L1-L5"); // new code ref from the second meeting

    const ledger = await store.loadLedger();
    expect(Object.keys(ledger.drafts)).toHaveLength(4);
    const manifest1 = JSON.parse(await readFile(path.join(config.outDir, "planning-2026-11-03", "manifest.json"), "utf8"));
    expect(manifest1.drafts[0].meetings).toEqual(["planning-2026-11-03", "sprint-review-2026-11-17"]);
    const manifest3 = JSON.parse(await readFile(path.join(config.outDir, "sprint-review-2026-11-17", "manifest.json"), "utf8"));
    expect(manifest3.mergedInto).toEqual([{ title: repeated!.draft.content.title, into: original.draftId }]);
  });

  it("meeting 4: an action without related code is drafted with 'no related code'", async () => {
    const { run } = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"]);
    expect(run.drafts).toHaveLength(1);
    expect(run.drafts[0]!.draft.refs).toEqual([]);
    expect(run.drafts[0]!.draft.owner).toBe("Priya Nair");
    const r = await finalize(run, approveAll(run), { store, config });
    expect(await readFile(r.written[0]!.file, "utf8")).toContain("**Related code:** _none identified_");
  });

  it("retries invalid JSON and falls back to an empty, flagged draft when retries run out", async () => {
    const retried = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"], scenario({ p3Failures: 1 }));
    expect(retried.responder.calls["retry"]).toBe(1);
    const retryLog = await readFile(store.pendingLogFile(retried.run.meetingId), "utf8");
    expect(retryLog).toContain("PROMPT P3 (RETRY 1) =====\nYour previous reply could not be used");
    expect(retried.run.drafts[0]!.draft.flags).toEqual([]);
    expect(retried.run.drafts[0]!.draft.content.objective).toContain("Problem:");

    const failed = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"], scenario({ p3Failures: 5 }), true);
    const d = failed.run.drafts[0]!.draft;
    expect(d.flags).toContain("Automatic drafting failed; sections must be completed manually.");
    expect(d.content).toMatchObject({ title: "Write release announcement post", objective: "", acceptanceCriteria: [] });
  });

  it("applies edits made during review", async () => {
    const { run } = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"]);
    const d = run.drafts[0]!.draft;
    const r = await finalize(run, { [d.id]: { action: "approve", content: { ...d.content, title: "Announce the next minor release", type: "UserStory" } } }, { store, config });
    const md = await readFile(r.written[0]!.file, "utf8");
    expect(path.basename(r.written[0]!.file)).toBe("01-announce-the-next-minor-release.md");
    expect(md).toContain("**Type:** User Story");
  });
});

function P1PromptContainsNotes(prompts: string[]): boolean {
  const p1 = prompts.find((p) => p.includes("# Task P1"));
  return Boolean(p1 && p1.includes("Missing mandatory option error") && p1.includes('Meeting: "Planning 2026-11-03"'));
}

describe("forced re-run of a processed meeting", () => {
  it("keeps earlier drafts in the meeting record and continues file numbering", async () => {
    const first = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"]);
    const r1 = await finalize(first.run, approveAll(first.run), { store, config });
    const second = await runMeeting("Team sync 2026-11-20", ["04-team-sync-2026-11-20.md"], scenario(), true);
    const d = second.run.drafts[0]!.draft;
    expect(second.run.drafts[0]!.dedup).toMatchObject({ status: "duplicate", layer: "L2", duplicateOf: r1.written[0]!.draftId });
    const r2 = await finalize(second.run, { [d.id]: { action: "approve", content: { ...d.content, title: "Announce v15" } } }, { store, config });
    expect(path.basename(r2.written[0]!.file)).toBe("02-announce-v15.md");
    const ledger = await store.loadLedger();
    expect(ledger.meetings["team-sync-2026-11-20"]!.drafts).toEqual([r1.written[0]!.draftId, d.id]);
    const manifest = JSON.parse(await readFile(path.join(config.outDir, "team-sync-2026-11-20", "manifest.json"), "utf8"));
    expect(manifest.drafts.map((x: { issue: { title: string } }) => x.issue.title)).toEqual(["Write release announcement post", "Announce v15"]);
  });
});

describe("removing a draft created by mistake", () => {
  it("deletes the file, forgets it for duplicate checks and rewrites the manifest", async () => {
    const first = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"]);
    const r = await finalize(first.run, approveAll(first.run), { store, config });
    const victim = r.written[1]!;
    const removed = await removeDraft(store, victim.draftId);
    expect(removed.title).toBe(victim.title);
    expect(existsSync(victim.file)).toBe(false);
    const ledger = await store.loadLedger();
    expect(ledger.drafts[victim.draftId]).toBeUndefined();
    expect(ledger.meetings["planning-2026-11-03"]!.drafts).not.toContain(victim.draftId);
    const manifest = JSON.parse(await readFile(path.join(config.outDir, "planning-2026-11-03", "manifest.json"), "utf8"));
    expect(manifest.drafts.map((d: { draftId: string }) => d.draftId)).not.toContain(victim.draftId);
    await expect(removeDraft(store, "nope")).rejects.toThrow(/No draft/);
  });
});

describe("meeting recap and issue links", () => {
  it("adds the issue link to the recap, the index page and the merged meeting's recap", async () => {
    const m1 = await runMeeting("Planning 2026-11-03", ["01-planning-2026-11-03.md"]);
    const r1 = await finalize(m1.run, approveAll(m1.run), { store, config });
    const envDraft = r1.written[0]!.draftId;

    await expect(linkIssue(store, envDraft, "https://github.com/tj/commander.js/pull/1")).rejects.toThrow(/Not a GitHub issue URL/);
    await linkIssue(store, envDraft, "https://github.com/tj/commander.js/issues/42");
    expect(await readRecap(store, "planning-2026-11-03")).toContain("Ticket: https://github.com/tj/commander.js/issues/42");
    const index = await readFile(path.join(config.outDir, "planning-2026-11-03", "index.html"), "utf8");
    expect(index).toContain('href="https://github.com/tj/commander.js/issues/42"');
    expect(index).toContain("Meeting recap");

    // a later meeting that only repeats the action still gets a recap pointing to the same ticket
    const m3 = await runMeeting("Sprint Review 2026-11-17", ["03-sprint-review-2026-11-17.md"]);
    const [repeated, fresh] = m3.run.drafts;
    const r3 = await finalize(m3.run, {
      [repeated!.draft.id]: { action: "merge", into: envDraft },
      [fresh!.draft.id]: { action: "reject" },
    }, { store, config });
    expect(r3.recap).toBe(path.join(config.outDir, "sprint-review-2026-11-17", "recap.md"));
    const recap3 = (await readRecap(store, "sprint-review-2026-11-17"))!;
    expect(recap3).toContain("- No new actions.");
    expect(recap3).toContain("same as \"Mention env variable in missing mandatory option error\", ticket https://github.com/tj/commander.js/issues/42");
    await expect(readRecap(store, "nope")).rejects.toThrow(/No meeting/);
  });
});
