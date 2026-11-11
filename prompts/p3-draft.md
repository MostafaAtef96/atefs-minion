# Task P3 — draft the ticket

Draft a ticket in the team's Standardized Ticket Format for this action item.

Action item (from the meeting "{{meetingTitle}}"):
```json
{{action}}
```

Related code found in the repository:
{{refs}}

Fill these fields:
- `title`: keep or improve the action title (imperative, max ~80 characters).
- `type`: "UserStory" or "Task" (keep the extracted type unless clearly wrong).
- `objective`: the "why" and "what" in ONE of these forms, whichever fits best:
  - "As a [user/role], I want to [desired action], so that [reason/benefit]."
  - "In order to …, we want to …, so that …"
  - "Problem: [current pain point]. Proposed Solution: [desired state/behaviour]."
- `inScope`: what will be developed or modified (list).
- `outOfScope`: what is explicitly excluded (list). Only what the meeting said or what clearly follows; else empty.
- `dependencies`: other planned work or technical dependencies mentioned (list).
- `acceptanceCriteria`: clear, binary, testable statements (list).
- `dod`: numbers of the Definition-of-Done criteria that apply to this ticket, chosen from:
{{dodList}}
  (e.g. a pure code change usually needs 7, 8, 11; changed behaviour also needs 5 and 10; new third-party dependencies need 12.)
- `deliverables`: the concrete, configuration-managed outputs when the ticket is closed (list).

Use ONLY information from the meeting and the code. Leave a list empty (or `objective` empty) when the meeting gave no basis for it — the team completes it during refinement. Do not invent requirements, numbers, names or dates.

Return:
```json
{"title": "...", "type": "Task", "objective": "...", "inScope": [], "outOfScope": [], "dependencies": [], "acceptanceCriteria": [], "dod": [7, 8, 11], "deliverables": []}
```
