# Task P4 — duplicate check

A new ticket draft was produced from the meeting "{{meetingTitle}}". Decide whether it describes the SAME piece of work as one of the earlier drafts listed below (possibly worded differently).

New draft:
```json
{{newDraft}}
```

Earlier drafts for the same repository:
```json
{{candidates}}
```

Rules:
- "Same work" means a developer would do essentially one piece of work for both. Related-but-different work (e.g. a follow-up, a different component, a different bug) is NOT a duplicate.
- If it is a duplicate, set `duplicateOf` to the `id` of the earlier draft, else null.
- `confidence` 0..1, `reason` one sentence.

Return:
```json
{"duplicateOf": null, "confidence": 0.8, "reason": "..."}
```
