# Synthetic sample meetings

These meeting exports are **invented** for testing. They copy the layout of Google Meet's
"Notes by Gemini" document (Summary / Details / Suggested next steps) and its transcript tab, as
downloaded via *File → Download → Markdown*. People and discussions are fictional.

All samples target the open-source repository [`tj/commander.js`](https://github.com/tj/commander.js)
at tag **`v14.0.3`**. Clone it once and use it as the source code path:

```bash
git clone --depth 1 --branch v14.0.3 https://github.com/tj/commander.js commander-v14.0.3
```

| File | Scenario | Expected result |
|---|---|---|
| `01-planning-2026-11-03.md` | Planning meeting with clear actions, some tied to code | 3 drafts; "drop Node 20" is **not** drafted (postponed) |
| `02-grooming-notes.md` + `02-grooming-transcript.md` | Vague brainstorming; Gemini suggests next steps that were never agreed | 0 drafts (all items discussion-only) |
| `03-sprint-review-2026-11-17.md` | Repeats the "mandatory option / env variable" action from meeting 1 in other words, plus one new action | 1 merge proposal + 1 new draft |
| `04-team-sync-2026-11-20.md` | Action with no related code (release announcement) | 1 draft with "no related code" |

Example:

```bash
minion run --notes samples/01-planning-2026-11-03.md --meeting "Planning 2026-11-03" --src ../commander-v14.0.3 --repo tj/commander.js
```
