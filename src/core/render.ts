import { DOD_CRITERIA } from "./dod.js";
import { TicketContent, type Draft, type TicketType } from "./schemas.js";

export const AGENT_NAME = "Atef's Minion";
export const AGENT_LABEL = "atefs-minion";
/** Mascot shown next to the signature (a public PNG, because GitHub Markdown can only show images by URL). */
export const DEFAULT_SIGNATURE_IMAGE = "https://raw.githubusercontent.com/MostafaAtef96/atefs-minion/main/assets/minion-signature.png";
let signatureImage: string | null = DEFAULT_SIGNATURE_IMAGE;

/** Set the signature image URL (null = text-only signature). */
export function setSignatureImage(url: string | null): void {
  signatureImage = url;
}

function signature(meetingNames: string): string {
  const img = signatureImage ? `<img src="${signatureImage}" width="20" height="20" alt="${AGENT_NAME}"> ` : "";
  return `${img}Drafted by **${AGENT_NAME}** · Source: ${meetingNames}`;
}
const TBD = "_To be defined during refinement_";

const TYPE_LABEL: Record<TicketType, string> = { UserStory: "User Story", Task: "Task" };

function list(items: string[], checkbox = false): string {
  if (items.length === 0) return TBD;
  return items.map((i) => (checkbox ? `- [ ] ${i}` : `- ${i}`)).join("\n");
}

function quoteLine(q: { text: string; speaker?: string | null; timestamp?: string | null }): string {
  const who = [q.speaker, q.timestamp].filter(Boolean).join(", ");
  const text = q.text.replace(/\s*\n\s*/g, " ");
  return `> "${text}"${who ? ` — ${who}` : ""}`;
}

function renderDod(selected: number[]): string {
  const sel = new Set(selected);
  const proposed = DOD_CRITERIA.map((name, i) => ({ n: i + 1, name })).filter((c) => sel.has(c.n));
  const others = DOD_CRITERIA.map((name, i) => ({ n: i + 1, name })).filter((c) => !sel.has(c.n));
  const lines = ["_Proposed by the agent; tailor during refinement (DoR)._", ""];
  if (proposed.length === 0) lines.push(TBD);
  else lines.push(...proposed.map((c) => `- [ ] ${c.n}. ${c.name}`));
  if (others.length > 0) {
    lines.push(
      "",
      "<details><summary>Criteria not proposed for this ticket</summary>",
      "",
      ...others.map((c) => `- ${c.n}. ${c.name}`),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

/** Hidden, machine-readable metadata used for de-duplication (now) and GitHub search (MVP2). */
export function renderMetadata(draft: Draft): string {
  const meta = {
    fingerprint: draft.fingerprint,
    meetings: draft.sources.map((s) => s.meetingId),
    draft_id: draft.id,
  };
  return `<!-- ${AGENT_LABEL}:v1 ${JSON.stringify(meta)} -->`;
}

/** Issue body (everything except the title) — what MVP2 will send to GitHub. */
export function renderIssueBody(draft: Draft): string {
  const c = draft.content;
  const header = [
    `**Type:** ${TYPE_LABEL[c.type]}`,
    "**Status:** Draft",
    "**Story Points:** _to be estimated by the team_",
  ].join(" · ");
  const extra: string[] = [];
  if (draft.owner) extra.push(`**Owner (from meeting):** ${draft.owner}`);
  if (draft.due) extra.push(`**Due (from meeting):** ${draft.due}`);

  const sources = draft.sources
    .map((s) => [`**Raised in:** ${s.meetingTitle}`, ...s.quotes.map(quoteLine)].join("\n"))
    .join("\n\n");

  let code: string;
  if (draft.refs.length === 0) {
    code = "**Related code:** _none identified_";
  } else {
    const sha = draft.commitSha ? ` (commit \`${draft.commitSha.slice(0, 7)}\`)` : "";
    code = [
      `**Related code**${sha}:`,
      ...draft.refs.map((r) => {
        const range = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}-L${r.endLine}`;
        const sym = r.symbol ? ` — \`${r.symbol}\`` : "";
        return `- [\`${r.path}#${range}\`](${r.permalink})${sym}: ${r.why}`;
      }),
    ].join("\n");
  }

  const flags = draft.flags.length ? `\n\n${draft.flags.map((f) => `> **Note:** ${f}`).join("\n")}` : "";
  const meetingNames = [...new Set(draft.sources.map((s) => `*${s.meetingTitle}*`))].join(", ");

  return [
    header,
    ...(extra.length ? ["", extra.join(" · ")] : []),
    "",
    "## Objective",
    c.objective.trim() || TBD,
    "",
    "## In Scope",
    list(c.inScope),
    "",
    "## Out of Scope",
    list(c.outOfScope),
    "",
    "## Dependencies",
    list(c.dependencies),
    "",
    "## Acceptance Criteria",
    list(c.acceptanceCriteria, true),
    "",
    "## Definition of Done",
    renderDod(c.dod),
    "",
    "## Deliverable",
    list(c.deliverables),
    "",
    "---",
    "## Source & Context",
    "**Upstream traceability:** Stakeholder Requirement: _TBD (link before DoR)_",
    "",
    sources,
    "",
    code + flags,
    "",
    "---",
    signature(meetingNames),
    renderMetadata(draft),
    "",
  ].join("\n");
}

/** Full draft file: title heading + issue body. */
export function renderDraftFile(draft: Draft): string {
  return `# ${draft.content.title}\n\n${renderIssueBody(draft)}`;
}

// ---------------------------------------------------------------------------
// Editable representation (used by the CLI review "edit" action)
// ---------------------------------------------------------------------------
const SECTION_KEYS = {
  "objective": "objective",
  "in scope": "inScope",
  "out of scope": "outOfScope",
  "dependencies": "dependencies",
  "acceptance criteria": "acceptanceCriteria",
  "definition of done": "dod",
  "deliverable": "deliverables",
} as const;

export function renderEditable(c: TicketContent): string {
  const items = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "");
  const sel = new Set(c.dod);
  return [
    "<!-- Edit the ticket below and save. Title = '# ' line, Type = UserStory or Task. -->",
    "<!-- One list item per '- ' line. Empty sections render as 'to be defined'. -->",
    `# ${c.title}`,
    `Type: ${c.type}`,
    "",
    "## Objective",
    c.objective,
    "",
    "## In Scope",
    items(c.inScope),
    "",
    "## Out of Scope",
    items(c.outOfScope),
    "",
    "## Dependencies",
    items(c.dependencies),
    "",
    "## Acceptance Criteria",
    items(c.acceptanceCriteria),
    "",
    "## Definition of Done",
    "<!-- Mark the applicable criteria with [x] -->",
    ...DOD_CRITERIA.map((name, i) => `- [${sel.has(i + 1) ? "x" : " "}] ${i + 1}. ${name}`),
    "",
    "## Deliverable",
    items(c.deliverables),
    "",
  ].join("\n");
}

export function parseEditable(text: string): TicketContent {
  const lines = text.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  let title = "";
  let type = "";
  let current: string | null = null;
  const buckets: Record<string, string[]> = {};
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    const ty = /^type:\s*(\S+)/i.exec(line);
    if (h2) {
      const key = SECTION_KEYS[h2[1]!.trim().toLowerCase() as keyof typeof SECTION_KEYS];
      current = key ?? null;
      if (current) buckets[current] = [];
    } else if (h1 && !current) {
      title = h1[1]!.trim();
    } else if (ty && !current) {
      type = ty[1]!;
    } else if (current) {
      buckets[current]!.push(line);
    }
  }
  const listOf = (key: string) =>
    (buckets[key] ?? [])
      .map((l) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l)?.[1]?.trim() ?? "")
      .filter(Boolean);
  const dod = (buckets["dod"] ?? [])
    .map((l) => /^\s*[-*]\s+\[[xX]\]\s+(\d+)/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  const normalizedType = /^task$/i.test(type) ? "Task" : /^user\s*story$/i.test(type) ? "UserStory" : type;
  return TicketContent.parse({
    title,
    type: normalizedType,
    objective: (buckets["objective"] ?? []).join("\n").trim(),
    inScope: listOf("inScope"),
    outOfScope: listOf("outOfScope"),
    dependencies: listOf("dependencies"),
    acceptanceCriteria: listOf("acceptanceCriteria"),
    dod,
    deliverables: listOf("deliverables"),
  });
}
