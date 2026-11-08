<p align="center"><img src="assets/minion.svg" width="120" alt="Atef's Minion mascot"></p>

# Atef's Minion

Atef's Minion turns the notes and transcript that **Gemini in Google Meet** writes for a meeting into
**reviewed ticket drafts** written in the team's *Standardized Ticket Format*.
Each draft includes links to the related source code.

It does not call an LLM API itself. It drives your own **Gemini CLI** over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com), so it needs no API key: it uses whatever
login Gemini CLI already has.

> **Phase 1 (MVP1)** produces drafts only. Nothing is created on GitHub.
> Creating issues, fetching the repo automatically and updating the calendar event come in MVP2.
> See [MASTER_PLAN.md](MASTER_PLAN.md).

```
notes/transcript ─┐
src code path    ─┼─▶ Minion (CLI or web form) ──ACP──▶ Gemini CLI (read-only tools)
meeting title    ─┤        │
GitHub repo      ─┘        ├─ extract decided actions
                           ├─ find related code → verify every file/line → permalinks
                           ├─ draft ticket (Standardized Ticket Format)
                           ├─ duplicate check against earlier meetings (local ledger)
                           ├─ YOUR REVIEW: approve / edit / reject / merge
                           └─▶ out/<meeting-id>/*.md + manifest.json
```

## Requirements

- **Node.js 20+**
- **Gemini CLI** installed and logged in. Run `gemini` once in a terminal and complete the login.
  Atef's Minion uses that same login.
- **git**
- A local **git clone** of the repository that the tickets are about

## Install (Windows, PowerShell)

```powershell
git clone https://github.com/<your-account>/atefs-minion.git
cd atefs-minion
npm ci
npm run build
npm link        # puts the `minion` command on your PATH
```

On macOS and Linux the same commands work in any shell.

## Configure (optional)

Copy `minion.config.example.json` to `minion.config.json` in the folder you run `minion` from:

| Key | Default | Meaning |
|---|---|---|
| `geminiCommand` | `gemini` | Command that starts Gemini CLI |
| `geminiArgs` | `["--acp"]` | Arguments that start Gemini CLI in ACP mode. Very old versions need `["--experimental-acp"]` |
| `model` | *(Gemini CLI default)* | Model, passed to Gemini CLI as `-m` |
| `defaultRepo` | – | Repository used when `--repo` is not given |
| `outDir` | `out` | Where approved drafts are written |
| `stateDir` | `~/.atefs-minion` | Holds the de-duplication ledger and the runs waiting for review |
| `maxRetries` | `2` | Retries when Gemini's answer doesn't match the expected JSON |
| `logPrompts` | `true` | Keep prompts and answers in `run.log` (local only) |
| `promptTimeoutSec` | `600` | Timeout for a single Gemini turn, in seconds |
| `signatureImage` | mascot PNG in this repo | Image URL shown next to the ticket signature; `null` = text only |
| `webPort` | `4711` | Port of the local web form |

## Export the meeting notes

1. Open the Google Doc named **"Notes by Gemini"** that is attached to the calendar event.
2. Choose **File → Download → Markdown (.md)** or **Plain text (.txt)**.
3. If transcription was on, the transcript is part of the same document (Transcript tab) or a separate
   document. Export it the same way. You can pass one file or two.

## Use it

### Command line

```powershell
minion run --notes "C:\Users\me\Downloads\Sprint Review.md" `
           --meeting "Sprint Review 2026-11-05" `
           --src C:\work\my-repo `
           --repo my-org/my-repo
```

The command shows progress, then takes you through the drafts one by one.
Gemini reads code for every action, so a run takes a few minutes. The first real run, a meeting with
3 actions, took about 5½ minutes.

- `a`: approve the draft
- `e`: edit it in your editor (Notepad on Windows, or `$EDITOR`)
- `t`: switch between User Story and Task
- `r`: reject it
- When a draft is **already ticketed** (an earlier meeting raised the same action), the choices change:
  - `m` (default): merge into the existing ticket. The new meeting and its quotes are always added. You also
    get a numbered list of new details, and only the ones you pick are added (Enter = none, `a` = all, `1,3` = some).
  - `n`: create a second ticket anyway. You are asked to confirm.

Other commands:

```text
minion run … --no-review         generate drafts now, review later
minion review                    list meetings waiting for review
minion review <meeting-id>       review them
minion web [--port 4711]         local web form + review table (http://127.0.0.1:4711)
minion ledger list               processed meetings and their drafts
minion ledger show <id>          details of a meeting or draft
minion ledger remove <draft-id>  remove a draft created by mistake (deletes its file; asks first)
minion run … --force             process a meeting again
```

### Web form

Run `minion web` and open the address it prints. In the form:

1. Choose the exported notes file(s).
2. Enter the meeting title, the repository, and the path to your local clone.
3. Click **Generate drafts**.
4. Each draft appears as an editable card. Approve or reject each one, then click **Save decisions**.
   For a draft that is already ticketed, **Merge into existing ticket** is preselected. Tick any new details
   you want added; **Create a new ticket anyway** asks for confirmation when you save.

The server listens on `127.0.0.1` only.

## What you get

```
out/<meeting-id>/
  01-<title>.md     draft: "# Title" + body in the Standardized Ticket Format, signed by Atef's Minion
  manifest.json     machine-readable drafts (issue title/body/labels) — input for MVP2
  run.log           every prompt and answer (including retries), each file Gemini read or searched,
                    every tool the app allowed or denied, and the total run time (turn off with --no-log)
```

Each draft:

- **Sections:** Objective, In Scope, Out of Scope, Dependencies, Acceptance Criteria, Definition of Done
  (the agent proposes which criteria apply; the team tailors them during refinement), and Deliverable.
- **Source & Context:** the meeting, verbatim quotes, and **links to the related code**. The links point to
  the exact commit and line ranges.
- **Never invented:** a section the meeting didn't cover says *"To be defined during refinement"*.
  Story Points are never estimated and Sub-Tasks are never created.
- **Signed:** a visible footer, `Drafted by Atef's Minion` with the green mascot next to it (set `signatureImage` to `null` in the config for text only), plus a hidden
  `<!-- atefs-minion:v1 {...} -->` block used for duplicate detection.

## Duplicate prevention

| Layer | What it catches |
|---|---|
| L1 | The same meeting, or the same notes, processed twice. Refused unless `--force` is given. |
| L2 | An action whose title is the same as an earlier draft's (after normalisation). |
| L3 | The same action worded differently. Gemini compares it with earlier drafts for the same repository. |
| L4 | **You decide** in the review. A merge adds the new meeting and its quotes to the existing draft and rewrites that draft's file. New details (scope items, acceptance criteria, code links) are added only if you pick them, so the ticket doesn't fill up with re-worded copies. Code links that overlap ones already on the ticket are not offered. |

## Safety

- **Gemini can only read your code.** When Gemini CLI asks for permission to use a tool, the app allows only
  read, search and think tools. File edits, shell commands and web fetches are denied, and this is enforced
  by the app, not by the prompt.
- **Every code reference is checked** before it is kept. The file must be tracked by git and the line range
  must exist. Anything else is dropped, so made-up references never reach a draft.
- **Only Gemini CLI sees the meeting content.** Phase 1 makes no GitHub API calls.

## Checklist: end-to-end run on your machine

1. Run `gemini --version` and note the version. Run `gemini` once and make sure you are logged in.
2. Clone the sample repository:
   `git clone --depth 1 --branch v14.0.3 https://github.com/tj/commander.js commander-v14.0.3`
3. Run sample meeting 1:
   `minion run --notes samples/01-planning-2026-11-03.md --meeting "Planning 2026-11-03" --src commander-v14.0.3 --repo tj/commander.js`
   - [ ] 3 drafts are offered. "Drop Node 20 support" is listed as *not drafted*.
   - [ ] Code links open the correct lines on github.com.
   - [ ] Approve them. The files appear in `out/planning-2026-11-03/`.
4. Run sample meeting 2:
   `minion run --notes samples/02-grooming-notes.md samples/02-grooming-transcript.md --meeting "Grooming 2026-11-10" --src commander-v14.0.3 --repo tj/commander.js`
   - [ ] No drafts are produced.
5. Run sample meeting 3:
   `minion run --notes samples/03-sprint-review-2026-11-17.md --meeting "Sprint Review 2026-11-17" --src commander-v14.0.3 --repo tj/commander.js`
   - [ ] The environment-variable action is offered as **merge** into the draft from meeting 1.
6. Run meeting 1 again with no other change:
   - [ ] It is refused as already processed.
7. Repeat step 3 with `minion web`.
8. If anything fails or a draft looks wrong, keep `run.log` and the console output. They show what Gemini
   read, what it answered and what was denied, so we can tune the prompts in `prompts/`. Remove anything
   confidential from them before sharing.

## Development

```bash
npm ci
npm run build
npm test
```

The tests run without Gemini or network access:

- A **scripted stand-in for Gemini** is used for the pipeline tests.
- `test/fixtures/fake-gemini.mjs`, a real ACP agent over stdio, checks the Gemini CLI launcher, the
  read-only permission policy, timeouts and the CLI end to end.

Project layout:

```
src/core      pipeline, schemas, rendering, ledger, ref verification, finalize/merge
src/control   ACP client, Gemini CLI launcher, permission policy, JSON retry loop
src/cli       `minion` command + terminal review
src/web       local web server (page in web/index.html)
prompts/      system prompt and task prompts P1–P4
samples/      synthetic meeting exports (see samples/README.md)
test/         unit, ACP, pipeline, CLI and web tests
```

## License

[Apache License 2.0](LICENSE) — free to use, modify and share, including inside companies; keep the
copyright and license notice (see [NOTICE](NOTICE)).
