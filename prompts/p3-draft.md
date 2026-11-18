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

Fill EVERY field from the discussion, including small details (constraints, edge cases, people or teams mentioned, tools, formats, timing):
- Prefer what was said explicitly. Where the meeting implies something without saying it, still write the most likely item and end it with " (to confirm)", so the team sees it was inferred.
- `outOfScope`: what the meeting excluded, postponed or kept for later, plus clear boundaries of this action (e.g. "Changing X" when only Y was agreed).
- `dependencies`: people, teams, tickets, decisions, access or tools this work waits for.
- `acceptanceCriteria`: at least two binary, testable statements.
- `deliverables`: the concrete outputs (code change, document, test report, configuration, decision record…).
- Leave a list empty only if the meeting gives no basis at all for it.
- Never invent names, numbers, dates or technical facts that were not discussed.

Return:
```json
{"title": "...", "type": "Task", "objective": "...", "inScope": [], "outOfScope": [], "dependencies": [], "acceptanceCriteria": [], "dod": [7, 8, 11], "deliverables": []}
```
