import type { RequestPermissionRequest, RequestPermissionResponse, ToolKind } from "@agentclientprotocol/sdk";

/** Tool kinds the agent may use: reading/searching the code only (plan §4.1 rule 2). */
export const ALLOWED_TOOL_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["read", "search", "think"]);

export interface PermissionDecision {
  allowed: boolean;
  response: RequestPermissionResponse;
}

/**
 * Read-only policy enforced by the app, not by the prompt:
 * allow read/search/think tools, reject edits, deletes, moves, shell execution, web fetches and anything unknown.
 */
export function decidePermission(req: RequestPermissionRequest): PermissionDecision {
  const kind = req.toolCall.kind ?? "other";
  const allowed = ALLOWED_TOOL_KINDS.has(kind);
  const wanted = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const option = wanted
    .map((k) => req.options.find((o) => o.kind === k))
    .find((o) => o !== undefined);
  if (!option) {
    return { allowed: false, response: { outcome: { outcome: "cancelled" } } };
  }
  return { allowed, response: { outcome: { outcome: "selected", optionId: option.optionId } } };
}
