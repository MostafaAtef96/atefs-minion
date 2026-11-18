import { AGENT_NAME } from "./render.js";
import type { Draft, Ledger } from "./schemas.js";

export interface RecapInput {
  meetingTitle: string;
  /** Drafts approved for this meeting (in order). */
  drafts: Draft[];
  /** Repeated actions merged into earlier tickets. */
  mergedInto: { title: string; into: string }[];
  /** Discussed but not decided. */
  skipped: string[];
  ledger: Ledger;
}

function ticket(d: Draft | undefined): string {
  if (!d) return "unknown";
  return d.issueUrl ? d.issueUrl : "to be created";
}

/**
 * Ready-to-send meeting recap: decisions and actions with owners and tickets, actions raised again,
 * and what was discussed without a decision. Plain text, so it pastes cleanly into an email or chat.
 */
export function renderRecap(input: RecapInput): string {
  const lines: string[] = [`Recap: ${input.meetingTitle}`, ""];

  lines.push("Decisions and actions:");
  if (input.drafts.length === 0) lines.push("- No new actions.");
  input.drafts.forEach((d, i) => {
    const facts = [
      `Owner: ${d.owner || "not named in the meeting"}`,
      ...(d.due ? [`Due: ${d.due}`] : []),
      d.content.type === "Task" ? "Task" : "User Story",
    ];
    lines.push(`${i + 1}. ${d.content.title}`, `   ${facts.join(" · ")}`, `   Ticket: ${ticket(d)}`);
  });

  const shown = new Set(input.drafts.map((d) => d.id));
  const again = input.mergedInto.filter((m) => !shown.has(m.into));
  if (again.length) {
    lines.push("", "Raised again (already ticketed):");
    for (const m of again) {
      const target = input.ledger.drafts[m.into];
      const where = target ? `"${target.content.title}"` : "an earlier ticket";
      lines.push(`- ${m.title}: same as ${where}, ticket ${ticket(target)}`);
    }
  }

  if (input.skipped.length) {
    lines.push("", "Discussed, no decision yet:");
    for (const s of input.skipped) lines.push(`- ${s}`);
  }

  lines.push("", `Prepared with ${AGENT_NAME} from the meeting notes.`, "");
  return lines.join("\n");
}

const ISSUE_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/\d+\/?$/;

export function isIssueUrl(url: string): boolean {
  return ISSUE_URL.test(url.trim());
}
