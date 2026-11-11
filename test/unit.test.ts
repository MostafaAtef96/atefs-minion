import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decidePermission } from "../src/control/permissions.js";
import { forTerminal } from "../src/cli/review.js";
import { extractJson } from "../src/control/json.js";
import { loadConfig } from "../src/core/config.js";
import { mergeDrafts } from "../src/core/finalize.js";
import { MAX_ISSUE_URL, newIssueLink, renderIndexPage } from "../src/core/export.js";
import { originMatchesRepo, listTrackedFiles, readGitInfo } from "../src/core/git.js";
import { validateInputs } from "../src/core/inputs.js";
import { permalink, verifyRefs } from "../src/core/refs.js";
import { AGENT_NAME, DEFAULT_SIGNATURE_IMAGE, parseEditable, renderDraftFile, renderEditable, setSignatureImage } from "../src/core/render.js";
import type { Draft, TicketContent } from "../src/core/schemas.js";
import { fingerprint, normalizeTitle, slugify } from "../src/core/text.js";
import { makeRepo, tempDir } from "./helpers.js";

const content: TicketContent = {
  title: "Mention env variable in missing mandatory option error",
  type: "Task",
  objective: "Problem: users are not told about the env variable. Proposed Solution: name it in the error.",
  inScope: ["Error message of missingMandatoryOptionValue"],
  outOfScope: ["Changing the error code"],
  dependencies: [],
  acceptanceCriteria: ["Error names the env variable when one is configured"],
  dod: [7, 8, 11],
  deliverables: ["Merged PR with tests"],
};

function draft(over: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    repo: "tj/commander.js",
    commitSha: "a".repeat(40),
    content,
    owner: "Lena",
    due: null,
    sources: [{ meetingId: "m1", meetingTitle: "Planning", quotes: [{ text: "I'll take it", speaker: "Lena", timestamp: "00:02:10" }] }],
    refs: [],
    fingerprint: fingerprint("tj/commander.js", content.title),
    flags: [],
    file: null,
    ...over,
  };
}

describe("text helpers", () => {
  it("slugifies meeting titles", () => {
    expect(slugify("Sprint Review — 2026-11-05!")).toBe("sprint-review-2026-11-05");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("Mention env variable in missing mandatory option error", 50)).toBe("mention-env-variable-in-missing-mandatory-option");
    expect(slugify("x".repeat(80), 10)).toBe("xxxxxxxxxx");
  });
  it("normalises titles order- and stopword-insensitively", () => {
    expect(normalizeTitle("Add the JSON help output")).toBe(normalizeTitle("JSON help output: add"));
    expect(fingerprint("A/B", "Fix login")).toBe(fingerprint("a/b", "fix   LOGIN!"));
  });
});

describe("extractJson", () => {
  it("prefers the last fenced block", () => {
    expect(extractJson('text ```json\n{"a":1}\n``` more ```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it("falls back to outer braces", () => {
    expect(extractJson('Sure! {"x": [1]} done')).toEqual({ x: [1] });
  });
  it("throws without JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("read-only permission policy", () => {
  const options = [
    { optionId: "y", name: "Allow", kind: "allow_once" as const },
    { optionId: "n", name: "Reject", kind: "reject_once" as const },
  ];
  const req = (kind: string | undefined) => ({
    sessionId: "s",
    toolCall: { toolCallId: "t", kind: kind as never },
    options,
  });
  it.each(["read", "search", "think"])("allows %s", (kind) => {
    expect(decidePermission(req(kind)).response).toEqual({ outcome: { outcome: "selected", optionId: "y" } });
  });
  it.each(["edit", "delete", "move", "execute", "fetch", "other", undefined])("denies %s", (kind) => {
    const d = decidePermission(req(kind));
    expect(d.allowed).toBe(false);
    expect(d.response).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
  });
  it("cancels when no reject option exists", () => {
    const d = decidePermission({ sessionId: "s", toolCall: { toolCallId: "t", kind: "edit" }, options: [options[0]!] });
    expect(d.response).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("rendering", () => {
  it("follows the Standardized Ticket Format and is signed", () => {
    const md = renderDraftFile(draft());
    for (const h of ["## Objective", "## In Scope", "## Out of Scope", "## Dependencies", "## Acceptance Criteria", "## Definition of Done", "## Deliverable", "## Source & Context"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain(`Drafted by **${AGENT_NAME}**`);
    expect(md).toMatch(/<!-- atefs-minion:v1 \{"fingerprint":"[0-9a-f]{16}","meetings":\["m1"\],"draft_id":"d1"\} -->/);
    expect(md).toContain("- [ ] 7. Software Detailed Design and Unit Construction");
    expect(md).toContain("_To be defined during refinement_"); // empty Dependencies
    expect(md).toContain('> "I\'ll take it" — Lena, 00:02:10');
    expect(md).toContain("_none identified_");
    expect(md).not.toMatch(/Story Points:\*\* \d/);
  });

  it("shows the mascot next to the signature, or text only when disabled", () => {
    expect(renderDraftFile(draft())).toMatch(/<img src="https:\/\/raw\.githubusercontent\.com\/MostafaAtef96\/atefs-minion\/main\/assets\/minion-signature\.png" width="20" height="20" alt="Atef's Minion"> Drafted by/);
    setSignatureImage(null);
    try {
      expect(renderDraftFile(draft())).toContain("\n---\nDrafted by **Atef's Minion** · Source: *Planning*");
    } finally {
      setSignatureImage(DEFAULT_SIGNATURE_IMAGE);
    }
  });

  it("round-trips the editable format", () => {
    const edited = renderEditable(content).replace("Type: Task", "Type: UserStory").replace("- [ ] 5. Software Requirements", "- [x] 5. Software Requirements");
    const parsed = parseEditable(edited);
    expect(parsed).toEqual({ ...content, type: "UserStory", dod: [5, 7, 8, 11] });
  });
});

describe("code references", () => {
  it("builds permalinks", () => {
    expect(permalink("o/r", "abc", "lib/a b.js", 3, 3)).toBe("https://github.com/o/r/blob/abc/lib/a%20b.js#L3");
    expect(permalink("o/r", "abc", "lib/a.js", 3, 9)).toBe("https://github.com/o/r/blob/abc/lib/a.js#L3-L9");
  });

  it("drops hallucinated or invalid references", async () => {
    const repo = await makeRepo(await tempDir());
    await writeFile(path.join(repo, "untracked.js"), "x\n");
    const git = await readGitInfo(repo);
    const tracked = await listTrackedFiles(repo);
    const refs = [
      { path: "lib/command.js", startLine: 10, endLine: 20, why: "ok" },
      { path: "./lib\\help.js", startLine: 5, endLine: 5, why: "ok, odd path" },
      { path: "lib/missing.js", startLine: 1, endLine: 2, why: "hallucinated" },
      { path: "lib/option.js", startLine: 30, endLine: 99, why: "out of range" },
      { path: "../etc/passwd", startLine: 1, endLine: 1, why: "escape" },
      { path: "untracked.js", startLine: 1, endLine: 1, why: "not committed" },
    ];
    const r = await verifyRefs({ refs, srcPath: repo, repo: "tj/commander.js", sha: git.headSha, tracked });
    expect(r.verified.map((v) => v.path)).toEqual(["lib/command.js", "lib/help.js"]);
    expect(r.verified[0]!.permalink).toBe(`https://github.com/tj/commander.js/blob/${git.headSha}/lib/command.js#L10-L20`);
    expect(r.dropped.map((d) => d.ref.why)).toEqual(["hallucinated", "out of range", "escape", "not committed"]);
    expect(r.adjusted).toEqual([]);
    expect(git.dirty).toBe(true);
    expect(git.onRemote).toBe(false);
  });

  it("trims an end line slightly past the end of the file instead of dropping the reference", async () => {
    const repo = await makeRepo(await tempDir());
    const git = await readGitInfo(repo);
    const tracked = await listTrackedFiles(repo);
    const r = await verifyRefs({
      refs: [
        { path: "lib/option.js", startLine: 20, endLine: 41, why: "one past the end" },
        { path: "lib/option.js", startLine: 20, endLine: 50, why: "far past the end" },
      ],
      srcPath: repo, repo: "tj/commander.js", sha: git.headSha, tracked,
    });
    expect(r.verified.map((v) => [v.startLine, v.endLine])).toEqual([[20, 40]]);
    expect(r.verified[0]!.permalink).toMatch(/#L20-L40$/);
    expect(r.adjusted[0]!.reason).toContain("trimmed to 40");
    expect(r.dropped.map((d) => d.ref.why)).toEqual(["far past the end"]);
  });

  it("matches origin URLs", () => {
    expect(originMatchesRepo("https://github.com/tj/commander.js.git", "tj/commander.js")).toBe(true);
    expect(originMatchesRepo("git@github.com:tj/commander.js.git", "TJ/Commander.js")).toBe(true);
    expect(originMatchesRepo("https://github.com/other/repo", "tj/commander.js")).toBe(false);
  });
});

describe("merging duplicates", () => {
  const ref = (path: string, startLine: number, endLine: number) => ({
    path, startLine, endLine, symbol: null, why: "x", permalink: `https://github.com/tj/commander.js/blob/sha/${path}#L${startLine}-L${endLine}`,
  });
  const existing = () => draft({ refs: [ref("lib/command.js", 100, 120)] });
  const incoming = () => draft({
    id: "d2",
    content: { ...content, title: "Tell users which env var to set", acceptanceCriteria: ["error names the env variable when one is configured", "Works for options on parent commands"], dod: [5] },
    sources: [{ meetingId: "m3", meetingTitle: "Sprint Review", quotes: [{ text: "tell you which environment variable" }] }],
    refs: [ref("lib/command.js", 110, 130), ref("lib/option.js", 1, 5)],
  });

  it("lists only new details as candidates; overlapping code refs are not offered", () => {
    const { candidates } = mergeDrafts(existing(), incoming());
    expect(candidates.lists).toEqual({ acceptanceCriteria: ["Works for options on parent commands"] });
    expect(candidates.refs.map((r) => r.path)).toEqual(["lib/option.js"]);
    expect(candidates.count).toBe(2);
  });

  it("by default adds only the meeting and its quotes, not re-worded details", () => {
    const { merged } = mergeDrafts(existing(), incoming());
    expect(merged.id).toBe("d1");
    expect(merged.content).toEqual(content);
    expect(merged.refs).toHaveLength(1);
    expect(merged.sources.map((s) => s.meetingId)).toEqual(["m1", "m3"]);
  });

  it("adds exactly the details the reviewer picked", () => {
    const picked = { acceptanceCriteria: ["Works for options on parent commands"], refs: [ref("lib/option.js", 1, 5).permalink] };
    const { merged } = mergeDrafts(existing(), incoming(), picked);
    expect(merged.content.acceptanceCriteria).toEqual([...content.acceptanceCriteria, "Works for options on parent commands"]);
    expect(merged.refs.map((r) => r.path)).toEqual(["lib/command.js", "lib/option.js"]);
    expect(merged.content.dod).toEqual(content.dod);
  });

  it("re-running the same meeting adds new quotes to that meeting instead of a second source", () => {
    const again = draft({ id: "d3", sources: [{ meetingId: "m1", meetingTitle: "Planning", quotes: [{ text: "I'll take it" }, { text: "message only" }] }] });
    const { merged } = mergeDrafts(existing(), again);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]!.quotes.map((q) => q.text)).toEqual(["I'll take it", "message only"]);
  });
});

describe("inputs and config", () => {
  it("validates inputs and derives meeting id + hash", async () => {
    const repo = await makeRepo(await tempDir());
    const v = await validateInputs({ notes: [{ name: "n.md", content: "hello" }], srcPath: repo, meetingTitle: " Planning 2026 ", repo: "https://github.com/tj/commander.js.git" });
    expect(v.meetingId).toBe("planning-2026");
    expect(v.repo).toBe("tj/commander.js");
    await expect(validateInputs({ notes: [], srcPath: "/nope", meetingTitle: "", repo: "bad" })).rejects.toThrow(/notes[\s\S]*title[\s\S]*owner\/name[\s\S]*not a directory/);
  });

  it("loads config files and rejects invalid ones", async () => {
    const dir = await tempDir();
    expect(loadConfig(undefined, dir).geminiArgs).toEqual(["--acp"]);
    await writeFile(path.join(dir, "minion.config.json"), JSON.stringify({ defaultRepo: "o/r", outDir: "drafts" }));
    const cfg = loadConfig(undefined, dir);
    expect(cfg.defaultRepo).toBe("o/r");
    expect(cfg.outDir).toBe(path.join(dir, "drafts"));
    await writeFile(path.join(dir, "bad.json"), JSON.stringify({ maxRetries: 99 }));
    expect(() => loadConfig("bad.json", dir)).toThrow(/maxRetries/);
  });
});

describe("importing drafts into GitHub", () => {
  it("builds a pre-filled new-issue link", () => {
    const link = newIssueLink(draft());
    expect(link.complete).toBe(true);
    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe("https://github.com/tj/commander.js/issues/new");
    expect(url.searchParams.get("title")).toBe(content.title);
    expect(url.searchParams.get("labels")).toBe("atefs-minion");
    expect(url.searchParams.get("body")).toBe(link.body);
    expect(link.body).toContain("## Objective");
  });

  it("leaves the body out of the link when it is too long, so it can be pasted", () => {
    const long = draft({ content: { ...content, inScope: Array.from({ length: 200 }, (_, i) => `Scope item number ${i} with some words`) } });
    const link = newIssueLink(long);
    expect(link.complete).toBe(false);
    expect(link.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(new URL(link.url).searchParams.get("body")).toBeNull();
    expect(link.body).toContain("Scope item number 199");
  });

  it("renders an index page with one GitHub button per ticket", () => {
    const html = renderIndexPage("Planning <1>", "tj/commander.js", [draft(), draft({ id: "d2" })]);
    expect(html).toContain("<title>Planning &lt;1&gt; · Atef's Minion</title>");
    expect(html.match(/Open as GitHub issue/g)).toHaveLength(2);
    expect(html).toContain('href="https://github.com/tj/commander.js/issues/new?title=');
    expect(html).toContain('<svg class="logo"');
  });
});

describe("terminal review display", () => {
  it("hides the signature image tag and the hidden metadata", () => {
    const shown = forTerminal(renderDraftFile(draft()));
    expect(shown).not.toContain("<img");
    expect(shown).not.toContain("atefs-minion:v1");
    expect(shown).toContain("Drafted by **Atef's Minion**");
  });
});
