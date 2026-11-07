# Task P2 — find related code

Action item: "{{title}}"
Summary: {{summary}}

Search the repository in your working directory (read-only) and find the code that this action will most likely touch or that a developer must understand first.

Rules:
- Return at most 5 references, most relevant first. Prefer specific functions/classes over whole files.
- `path` is relative to the repository root, using forward slashes.
- `startLine`/`endLine` are 1-based line numbers that you have actually seen in the file. Keep ranges focused (ideally < 80 lines).
- `symbol` is the function/class/section name, or null.
- `why` is one sentence explaining the relevance.
- If nothing in the repository is related, return an empty list. Do not guess.

Return:
```json
{"refs": [{"path": "src/example.ts", "startLine": 10, "endLine": 42, "symbol": "exampleFn", "why": "..."}]}
```
