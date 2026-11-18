import { z } from "zod";
import type { AgentSession } from "./session.js";

/** Extract the JSON payload from an LLM reply (fenced ```json block preferred, else outermost braces). */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]!);
  for (const block of fences.reverse()) {
    try {
      return JSON.parse(block);
    } catch {
      // try next
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error("No JSON object found in the reply.");
}

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly lastReply: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Send a prompt and validate the reply against a schema; on failure send the validation
 * error back and retry (plan §4.1 rule 4).
 */
export async function askJson<S extends z.ZodType>(
  session: AgentSession,
  prompt: string,
  schema: S,
  maxRetries: number,
): Promise<z.infer<S>> {
  let text = prompt;
  let lastReply = "";
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastReply = await session.prompt(text);
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(lastReply));
      if (parsed.success) return parsed.data;
      problem = z.prettifyError(parsed.error);
    } catch (e) {
      problem = (e as Error).message;
    }
    lastError = problem;
    text = [
      "Your previous reply could not be used because it did not match the required JSON format.",
      "Problem:",
      problem,
      "",
      "Reply again with ONLY the corrected JSON in a single ```json fenced block. Do not add any other text.",
    ].join("\n");
  }
  throw new StructuredOutputError(`Invalid output after ${maxRetries + 1} attempts: ${lastError}`, lastReply);
}
