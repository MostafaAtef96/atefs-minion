import type { Draft, Ledger } from "./schemas.js";

export interface MinutesInput {
  meetingTitle: string;
  /** Main outcomes of the meeting (from the same AI step that extracts the actions). */
  highlights: string[];
  /** Drafts approved for this meeting (in order). */
  drafts: Draft[];
  /** Repeated actions merged into earlier tickets. */
  mergedInto: { title: string; into: string }[];
  /** Discussed but not decided. */
  skipped: string[];
  ledger: Ledger;
  /** Closing line of the email, e.g. "Best regards". */
  signOff?: string;
}

function ticket(d: Draft | undefined): string {
  if (!d) return "unknown";
  return d.issueUrl ? d.issueUrl : "to be created";
}

/**
 * Minutes of Meeting email, ready to copy and send to the participants: subject, main highlights,
 * action items with owner and ticket, actions already tracked, open points. Plain text.
 */
let defaultSignOff = "Best regards";
/** Closing line used in the minutes email (from the config). */
export function setMinutesSignOff(signOff: string | null | undefined): void {
  defaultSignOff = signOff?.trim() || "Best regards";
}

export function renderMinutes(input: MinutesInput): string {
  const lines: string[] = [
    `Subject: Minutes of Meeting – ${input.meetingTitle}`,
    "",
    "Hi all,",
    "",
    "thank you for joining. Please find the minutes of the meeting below.",
  ];

  if (input.highlights.length) {
    lines.push("", "Highlights:");
    for (const h of input.highlights) lines.push(`- ${h}`);
  }

  lines.push("", "Action items:");
  if (input.drafts.length === 0) lines.push("- No new action items.");
  input.drafts.forEach((d, i) => {
    const facts = [
      `Owner: ${d.owner || "not named in the meeting"}`,
      ...(d.due ? [`Due: ${d.due}`] : []),
      ...(d.midSprint ? ["mid-sprint"] : []),
    ];
    lines.push(`${i + 1}. ${d.content.title}`, `   ${facts.join(" · ")}`, `   Ticket: ${ticket(d)}`);
  });

  const shown = new Set(input.drafts.map((d) => d.id));
  const again = input.mergedInto.filter((m) => !shown.has(m.into));
  if (again.length) {
    lines.push("", "Already tracked (raised again):");
    for (const m of again) {
      const target = input.ledger.drafts[m.into];
      const where = target ? `"${target.content.title}"` : "an earlier ticket";
      lines.push(`- ${m.title}: same as ${where}, ticket ${ticket(target)}`);
    }
  }

  if (input.skipped.length) {
    lines.push("", "Open points (no decision yet):");
    for (const s of input.skipped) lines.push(`- ${s}`);
  }

  lines.push("", input.signOff || defaultSignOff, "");
  return lines.join("\n");
}

const ISSUE_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/\d+\/?$/;

export function isIssueUrl(url: string): boolean {
  return ISSUE_URL.test(url.trim());
}
