import { z } from "zod";

/** Ticket types the agent may draft (Deliverable level only — never Sub-Tasks). */
export const TicketType = z.enum(["UserStory", "Task"]);
export type TicketType = z.infer<typeof TicketType>;

export const Quote = z.object({
  text: z.string().min(1),
  speaker: z.string().nullish(),
  timestamp: z.string().nullish(),
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------------------
// P1 — action extraction
// ---------------------------------------------------------------------------
export const ExtractedAction = z.object({
  title: z.string().min(3).max(200),
  type: TicketType,
  owner: z.string().nullish(),
  due: z.string().nullish(),
  summary: z.string().min(1),
  quotes: z.array(Quote).default([]),
  decided: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** Set when the action clearly concerns another repo/system than the target repo. */
  otherTarget: z.string().nullish(),
});
export type ExtractedAction = z.infer<typeof ExtractedAction>;

export const P1Output = z.object({
  actions: z.array(ExtractedAction),
});
export type P1Output = z.infer<typeof P1Output>;

// ---------------------------------------------------------------------------
// P2 — code context
// ---------------------------------------------------------------------------
export const CodeRef = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  symbol: z.string().nullish(),
  why: z.string().min(1),
});
export type CodeRef = z.infer<typeof CodeRef>;

export const P2Output = z.object({
  refs: z.array(CodeRef).max(10),
});
export type P2Output = z.infer<typeof P2Output>;

// ---------------------------------------------------------------------------
// P3 — ticket drafting (Standardized Ticket Format)
// ---------------------------------------------------------------------------
export const TicketContent = z.object({
  title: z.string().min(3).max(200),
  type: TicketType,
  objective: z.string().default(""),
  inScope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Numbers (1–13) of the Definition-of-Done criteria proposed as applicable. */
  dod: z.array(z.number().int().min(1).max(13)).default([]),
  deliverables: z.array(z.string()).default([]),
});
export type TicketContent = z.infer<typeof TicketContent>;

export const P3Output = TicketContent;

// ---------------------------------------------------------------------------
// P4 — semantic duplicate check
// ---------------------------------------------------------------------------
export const P4Output = z.object({
  duplicateOf: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type P4Output = z.infer<typeof P4Output>;

// ---------------------------------------------------------------------------
// Drafts, ledger, pending runs
// ---------------------------------------------------------------------------
export const VerifiedRef = CodeRef.extend({
  permalink: z.string(),
});
export type VerifiedRef = z.infer<typeof VerifiedRef>;

export const SourceMeeting = z.object({
  meetingId: z.string(),
  meetingTitle: z.string(),
  quotes: z.array(Quote),
});
export type SourceMeeting = z.infer<typeof SourceMeeting>;

export const Draft = z.object({
  id: z.string(),
  repo: z.string(),
  commitSha: z.string().nullable(),
  content: TicketContent,
  owner: z.string().nullish(),
  due: z.string().nullish(),
  sources: z.array(SourceMeeting).min(1),
  refs: z.array(VerifiedRef),
  fingerprint: z.string(),
  flags: z.array(z.string()).default([]),
  /** Where the approved draft was written (absolute path). Set on finalize. */
  file: z.string().nullish(),
});
export type Draft = z.infer<typeof Draft>;

export const DedupProposal = z.object({
  status: z.enum(["new", "duplicate"]),
  duplicateOf: z.string().nullish(),
  layer: z.enum(["L2", "L3"]).nullish(),
  reason: z.string().nullish(),
});
export type DedupProposal = z.infer<typeof DedupProposal>;

export const PendingDraft = z.object({
  draft: Draft,
  dedup: DedupProposal,
});
export type PendingDraft = z.infer<typeof PendingDraft>;

export const SkippedAction = z.object({
  title: z.string(),
  reason: z.string(),
  quotes: z.array(Quote).default([]),
});
export type SkippedAction = z.infer<typeof SkippedAction>;

export const PendingRun = z.object({
  version: z.literal(1),
  meetingId: z.string(),
  meetingTitle: z.string(),
  repo: z.string(),
  srcPath: z.string(),
  commitSha: z.string().nullable(),
  inputHash: z.string(),
  createdAt: z.string(),
  drafts: z.array(PendingDraft),
  skipped: z.array(SkippedAction),
  warnings: z.array(z.string()),
});
export type PendingRun = z.infer<typeof PendingRun>;

export const LedgerMeeting = z.object({
  title: z.string(),
  repo: z.string(),
  inputHash: z.string(),
  processedAt: z.string(),
  outDir: z.string(),
  drafts: z.array(z.string()),
});
export type LedgerMeeting = z.infer<typeof LedgerMeeting>;

export const Ledger = z.object({
  version: z.literal(1),
  meetings: z.record(z.string(), LedgerMeeting),
  drafts: z.record(z.string(), Draft),
});
export type Ledger = z.infer<typeof Ledger>;

// ---------------------------------------------------------------------------
// Review decisions (shared by CLI and web)
// ---------------------------------------------------------------------------
export const ReviewDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), content: TicketContent.optional() }),
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("merge"), into: z.string() }),
]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;
