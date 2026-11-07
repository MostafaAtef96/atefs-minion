# Master Plan — Atef's Minion (Meeting-to-Ticket Agent)

> **Status:** v1.1 — Phase 1 (MVP1) **implemented**; awaiting your end-to-end check with real Gemini CLI (README checklist)
> **Owner:** Product Owner
> **Date:** 2026-11-07
> **History:**
> - v0.1: first draft with open questions.
> - v0.2: aligned with the brainstorming sketch.
> - v1.0: all questions answered and all suggestions approved.
> - v1.1: implementation notes added (§13). The items marked *(to verify at implementation)* are resolved.

---

## 1. Problem

After every meeting, the Product Owner manually turns the agreed actions into tickets. Today these are GitHub Issues.
Doing this by hand is slow, actions get missed, tickets end up vague, and the same action raised in two meetings can produce two tickets.

## 2. Product vision

**Atef's Minion** reads the notes and transcript that Gemini produces for a Google Calendar / Meet call. It extracts the action items that were *decided*, enriches them with references to the related source code, and drafts tickets in the team's **Standardized Ticket Format**. Every ticket is signed by the agent, and the same action is never ticketed twice.

**Platform:** Gemini CLI only, as required by the organisation. There is no Claude support. The app talks to Gemini CLI over **ACP (Agent Client Protocol)**, so the LLM backend stays replaceable, but nothing extra is built for that.

---

## 3. Phase 1 (MVP1) scope

### In scope
1. **Minion Interface** with 4 inputs: transcript/notes file, src code path, meeting title (ID), GitHub repo (`owner/name`).
2. The interface is offered as **both** a command-line tool and a local web form, built on one shared core.
3. **Agent Control**: starts Gemini CLI in ACP mode, sends the system prompt, and runs task prompts that each have defined inputs and an expected output schema.
4. Pipeline: **extract actions → find related code → draft tickets → check for duplicates → human review → save drafts**.
5. Tickets use the **Standardized Ticket Format**, and the agent decides **User Story vs Task** (you can change it in review).
6. **Signature** "Atef's Minion" on every draft.
7. **Duplicate prevention** with a local ledger, for a single user.
8. Target: **public github.com** repos, with code read from a **local clone**.
9. **Output:** approved drafts saved as Markdown and JSON. **Nothing is created on GitHub in Phase 1.**

### Out of scope (later phases)
| Item | Phase |
|---|---|
| Fetch the repo automatically from the GitHub path | MVP2 |
| Create issues on GitHub from the approved drafts | MVP2 |
| Check for duplicates against existing GitHub issues | MVP2 |
| Update the calendar event (meaning to be defined in MVP2) | MVP2 |
| the company GitHub Enterprise Server (3.19), GitHub Projects fields, official issue templates | Later |
| Codebeamer, coreALM | Later |
| Sub-Tasks (owned by the Solution Team, so the agent never drafts them) | Never |

---

## 4. Architecture

```
 ┌──────────────── Minion Interface ────────────────┐
 │  CLI:  minion run --notes … --src … --meeting …  │
 │        --repo owner/name                          │
 │  Web:  minion web → local form + review table     │
 └───────────────────────┬──────────────────────────┘
                         │ shared core library
 ┌───────────────────────▼──────────────────────────┐
 │                 Agent Control                     │
 │  • init: spawn `gemini` in ACP mode, cwd = src    │
 │  • system prompt + task prompts P1–P4             │
 │  • JSON-schema validation, retry with error       │
 │  • permission policy: read-only tools only        │
 └───────────────────────┬──────────────────────────┘
                         │  ACP (JSON-RPC over stdio)
                 ┌───────▼────────┐
                 │   Gemini CLI    │  built-in read/grep/glob tools
                 └────────────────┘  explore the src code path
 Local: ~/.atefs-minion/ledger.json · out/<meeting-id>/
```

### 4.1 Design rules
1. **Gemini CLI is the brain and the app is the conductor.** The app never calls an LLM API directly and needs no API key; it uses the user's existing Gemini CLI login.
2. **Read-only access to code.** When Gemini CLI asks for tool permission over ACP, the app automatically allows read, list, grep and glob, and **denies** file writes, edits and shell commands.
3. **Deterministic steps are done in code, not by the LLM:**
   - permalinks, built from `git rev-parse HEAD`
   - checking that every cited file and line range exists (anything that doesn't is dropped)
   - rendering the Markdown
   - fingerprints and the ledger
4. **Structured output.** Every prompt must return JSON that matches a `zod` schema. If it doesn't, the validation error is sent back to Gemini, up to 2 retries. After that, the item is marked failed and the run continues.
5. **One core, two front ends.** The command-line tool and the web form behave identically.
6. **Cross-platform:** Windows, macOS and Linux. This includes launching `gemini` as `gemini.cmd` on Windows.

### 4.2 Technology
- **TypeScript on Node.js 20+.** Gemini CLI requires this too, so it is already installed.
- **Official ACP TypeScript SDK** (`@agentclientprotocol/sdk` 2.4.0) to talk to Gemini CLI. Gemini CLI is started with **`--acp`**, checked against `@google/gemini-cli` 0.66.0 (your version) and 0.67.0. The older `--experimental-acp` flag is deprecated, and `geminiArgs` in the config lets you switch to it.
- `zod` for schemas, `commander` for the command-line tool, and a small built-in Node HTTP server plus one static page for the web form, with no heavy framework.
- `vitest` for tests, using a **fake ACP agent** with scripted replies so the tests run without Gemini or a network.

### 4.3 Configuration
`minion.config.json` holds defaults, all of which can be overridden by command-line flags:
- `geminiCommand`
- `model`
- `outDir`
- `ledgerPath`
- `defaultRepo`
- `maxRetries`
- `logPrompts`

---

## 5. Inputs

| Field | Handling |
|---|---|
| **Transcript / notes** | One or two file paths. Export the Google Doc "Notes by Gemini" (and its transcript, if transcription was on) via *File → Download* as **.md** or **.txt**. The agent treats Gemini's *Suggested next steps* as **candidates** and checks them against the transcript when one is available. |
| **Src code path** | A local git clone of the target repo. The app warns if there are uncommitted changes or if `HEAD` isn't on the remote, because the permalinks would then be broken. |
| **Meeting title (ID)** | Free text, e.g. `Sprint Review 2026-11-05`. It is turned into a slug that serves as the meeting ID in the ledger and as the output folder name. |
| **GitHub repo** | `owner/name` on github.com. In Phase 1 it is used only to build links. |

**Routing:** every action goes to the repo entered as input. If an action clearly belongs to another system or repo, the agent **flags** it in the review instead of rerouting it.

---

## 6. Pipeline

| Step | Actor | Description |
|---|---|---|
| 0 Pre-check | App | Validate the inputs and check the ledger for this meeting (L1). Processing the same meeting again requires `--force`. |
| 1 Init | App | Spawn Gemini CLI in ACP mode with cwd = src path, open a session, and send the system prompt. |
| 2 Extract | Gemini **P1** | Return the action items: `title, type (UserStory/Task), owner, due, summary, quotes[{text, speaker, timestamp}], decided:boolean, confidence`. Items with `decided=false` are shown in the review as "not drafted (discussion only)". |
| 3 Code context | Gemini **P2** (per item) | Explore the code read-only and return `refs[{path, startLine, endLine, symbol, why}]`, or an empty list. |
| 4 Verify refs | App | Drop invalid refs and build `https://github.com/<repo>/blob/<sha>/<path>#L<a>-L<b>`. |
| 5 Draft | Gemini **P3** (per item) | Fill in the sections of the Standardized Ticket Format as JSON. |
| 6 Dedup | App + Gemini **P4** | Compare against the ledger (L2 fingerprint, L3 semantic match) and propose `new` or `merge into <draft>`. |
| 7 Review | User | For each draft: **Approve / Edit / Reject / Merge / Change type**. On the command line, Edit opens the draft in `$EDITOR`; the web form provides a table with inline editing. |
| 8 Output | App | Write the approved drafts and `manifest.json`, then update the ledger. |

**Output layout**
```
out/<meeting-id>/
  01-<slug>.md      human-readable draft (copy-paste ready; MVP2 input)
  manifest.json     drafts, refs, fingerprints, review decisions, commit SHA
  run.log           prompts/responses (disable with --no-log)
~/.atefs-minion/ledger.json
```

**Commands**
- `minion run …`: runs the full pipeline and the review in the terminal.
- `minion run … --no-review`: produces drafts but leaves them pending.
- `minion review <meeting-id>`: reviews pending drafts later.
- `minion web [--port 4711]`: opens the local web form and review page.
- `minion ledger list | show <id>`: lists or shows past meetings and drafts.

---

## 7. Ticket draft format

### 7.1 Body
The standard sections come from the team's Standardized Ticket Format, followed by an agent section.

```markdown
**Type:** User Story | Task   **Status:** Draft   **Story Points:** _to be estimated by the team_

## Objective
As a <role>, I want to <action>, so that <benefit>.
(or "In order to… we want to… so that…", or "Problem: … Proposed Solution: …")

## In Scope
## Out of Scope
## Dependencies
## Acceptance Criteria
- [ ] <binary, testable statement>          (draft — EDL signs off)
## Definition of Done
_Proposed by the agent; tailor during refinement (DoR)._
- [ ] <pre-selected subset of the 13 DoD criteria>
## Deliverable

---
## Source & Context
**Upstream traceability:** Stakeholder Requirement: _TBD (link before DoR)_
**Raised in:** <meeting title>
> "<verbatim quote>" — <speaker>, <timestamp>
**Related code** (commit `<sha7>`):
- [`<path>#L<a>-L<b>`](<permalink>) — `<symbol>`: <why>

---
🤖 Drafted by **Atef's Minion** · Source: *<meeting title>*
<!-- atefs-minion:v1 {"fingerprint":"…","meetings":["<meeting-id>"],"draft_id":"…"} -->
```

### 7.2 Content rules
- **Never invent anything.** A section the meeting didn't cover is written as `_To be defined during refinement_`, so it is clear what is still missing for the DoR.
- **Story Points** are never estimated by the agent, and it drafts **no Sub-Tasks**.
- **Objective:** the agent picks whichever of the three allowed phrasings fits the item best.
- **DoD:** all 13 criteria are listed. The agent pre-checks the ones that are relevant and marks the selection as a proposal.

### 7.3 Signature
- **Visible footer:** "Drafted by Atef's Minion". In MVP2, when the agent itself creates the issue, this becomes "Created by".
- **Hidden metadata comment:** used for dedup.
- **Label:** `atefs-minion` is recorded in `manifest.json` and applied when the issue is created in MVP2.

### 7.4 Public repo hygiene
The project repo is public. It will contain the *structure* of the ticket format, but **no internal content** from tickets.md: no internal URLs, no hostnames, and no organisation-specific document links.

---

## 8. Duplicate prevention

| Layer | Catches | Phase 1 mechanism |
|---|---|---|
| L1 Meeting | The same meeting processed twice | Ledger keyed by meeting ID plus a hash of the input file. The app warns, and requires `--force` to continue. |
| L2 Fingerprint | The same action worded identically | Hash of the normalised title plus the repo. |
| L3 Semantic | The same action worded differently | P4 compares the new item with ledger entries for the same repo and returns `duplicate_of` and a reason. |
| L4 Human | Borderline cases | The review proposes "Merge into draft X (meeting Y)". |

**What a merge does:** no new draft is created. The existing draft gets an extra *Raised in* entry with the new quote, and any new details are proposed as additions for you to accept. Its metadata `meetings[]` grows, and the existing draft file is re-written in its original `out/` folder.

**MVP2 extension:** L2 and L3 also run against existing GitHub issues (found through the hidden metadata and the label, plus a keyword search for issues created by people). A merge then becomes a "🔁 Raised again in …" comment on the issue.

---

## 9. Testing

- **Reference repo for samples:** [`tj/commander.js`](https://github.com/tj/commander.js), pinned at tag **`v14.0.3`**. It is a well-known, mid-sized and stable open-source project. The tests clone that tag, so the code references are reproducible.
- **Synthetic meeting exports** in `samples/` mimic the "Notes by Gemini" layout (Summary / Details / Suggested next steps) and the transcript style (speaker and timestamp). They cover four cases:
  1. a planning meeting with 3–5 clear actions, some tied to code
  2. a meeting with vague, undecided discussion that must not become drafts
  3. a follow-up meeting that repeats an action from meeting 1 (dedup and merge)
  4. an action that has no related code
- **Automated tests** use the fake ACP agent to cover schemas, the permission policy, ref verification, rendering, the ledger and dedup, the full pipeline, and the command-line tool.
- **End-to-end runs with real Gemini CLI** are done by you, on your machine. The README will include a short checklist for this.

### Phase 1 acceptance criteria
1. The command-line tool and the web form both accept the 4 inputs and produce identical drafts.
2. On the synthetic samples, every *decided* action is drafted and no draft is produced for discussion-only items.
3. Every draft follows §7, carries the signature, and contains only code references that resolve.
4. The agent never writes to the src repo or runs shell commands there (tested against the permission policy).
5. Re-running the same meeting creates no new drafts (L1). Meeting 3 produces a merge proposal for the repeated action (L3/L4).
6. Nothing is written to `out/` without approval in the review.
7. All automated tests pass, and the README explains installation, configuration and the local end-to-end checklist.

---

## 10. Security & compliance
- Transcripts are sent only to Gemini CLI. Phase 1 makes no GitHub API calls.
- The web server binds to `127.0.0.1` only.
- `run.log` and `out/` stay local and are listed in `.gitignore`. Logging can be turned off with `--no-log`.
- The read-only tool policy is enforced by the app, not by the prompt.
- Real meeting data is never committed. `samples/` contains synthetic content only.

---

## 11. Implementation plan (Phase 1)

| # | Milestone | Deliverable |
|---|---|---|
| M1 | Repo skeleton | TypeScript project, lint, tests, CI (GitHub Actions: build + test), README stub, `.gitignore` |
| M2 | Schemas & renderer | zod schemas for P1–P4 outputs, Markdown renderer, signature and metadata |
| M3 | Agent Control | ACP client, Gemini CLI launcher (cross-platform), permission policy, retry loop, fake ACP agent |
| M4 | Prompts | `system.md`, `p1-extract.md`, `p2-code.md`, `p3-draft.md`, `p4-dedup.md` |
| M5 | Pipeline | Steps 0–8, ref verification, permalinks |
| M6 | Ledger & dedup | L1–L4, merge flow |
| M7 | Command-line tool | `run`, `review`, `ledger`, interactive review, `$EDITOR` editing |
| M8 | Web form | Local server, input form, review table |
| M9 | Samples & tests | Synthetic meetings for commander.js, end-to-end test with the fake agent, the acceptance criteria above |
| M10 | Docs | README: install, configure, local Gemini end-to-end checklist |

### Repository
- **Name:** `atefs-minion`, public, on your github.com account. Work happens on a feature branch, and changes are merged through a PR.
- **Layout:**
```
atefs-minion/
├── MASTER_PLAN.md
├── src/{core,control,prompts,cli,web}/
├── samples/
└── test/
```

---

## 12. Roadmap after Phase 1
| Phase | Scope |
|---|---|
| **MVP2** | Auto repo fetch · create GitHub issues from approved drafts · dedup against GitHub issues · calendar event update |
| Later | the company GitHub Enterprise Server · GitHub Projects (status `Draft`, iteration) · official issue templates · Codebeamer & coreALM |

---

## 13. Implementation notes (v1.1)

| Topic | Implemented as |
|---|---|
| ACP | `@agentclientprotocol/sdk` 2.4.0. Gemini CLI is started as `gemini --acp` with cwd = src path. The client advertises no file-system or terminal capabilities. |
| Login | Atef's Minion never calls ACP `authenticate`, because that can reset Gemini CLI's saved login. It relies on the login that already exists. If Gemini CLI is not logged in, the user gets a clear "run `gemini` once and log in" message. |
| Windows | `gemini` is the `gemini.cmd` shim, so it is started through the shell. On close, the whole process tree is killed (`taskkill /T`). CI runs on Windows and Linux with Node 20 and 22. |
| Pending runs | Drafts that wait for review are stored in `stateDir/pending/`, not in `out/`. This keeps acceptance criterion 6: nothing goes to `out/` without approval. |
| DoD rendering | The proposed criteria are rendered as unchecked boxes. The criteria that were not proposed go in a collapsed list. On GitHub a ticked box would read as "done", so nothing is pre-ticked. |
| Draft file | `# <title>` followed by the issue body. `manifest.json` carries `issue.title`, `issue.body` and `labels: ["atefs-minion"]`, ready for MVP2. |
| Forced re-run | `--force` on a meeting that was already processed keeps the earlier drafts, continues the file numbering, and proposes the repeated actions as L2 merges. |
| Licence | `UNLICENSED` (all rights reserved) until the owner chooses a licence. |
| Tests | 39 automated tests: unit, ACP over stdio with a fake Gemini, pipeline on the four samples, CLI, and web. Not tested: a real Gemini CLI (needs the owner's login). |
