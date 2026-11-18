# Task P1 — extract action items

Meeting: "{{meetingTitle}}"
Target repository: `{{repo}}`

Read the meeting material below and list every action item.

For each action item return:
- `title`: short imperative ticket title (max ~80 characters), e.g. "Support empty rows in CSV export".
- `type`: "UserStory" when it delivers user-visible value/behaviour; "Task" for mandatory engineering work (refactoring, CI, docs, investigations, setup).
- `owner`: person who took the action, if stated, else null.
- `due`: due date/time frame if stated, else null.
- `summary`: 1–3 sentences on what was decided and why.
- `quotes`: 1–3 short verbatim quotes that support the action. Copy text exactly; include `speaker` and `timestamp` when the source shows them, else null.
- `decided`: true only if the meeting clearly agreed to do it. Use false for ideas, open questions, "maybe later", or items explicitly postponed/rejected.
- `confidence`: 0..1, how sure you are that this is a correct, decided action.
- `otherTarget`: if the action clearly belongs to a different repository/system than `{{repo}}`, name it; else null.

Merge items that describe the same action. Do not split one action into sub-tasks.

Return:
```json
{"actions": [{"title": "...", "type": "UserStory", "owner": null, "due": null, "summary": "...", "quotes": [{"text": "...", "speaker": null, "timestamp": null}], "decided": true, "confidence": 0.9, "otherTarget": null}]}
```

Meeting material ({{fileCount}} file(s)):
{{notes}}
