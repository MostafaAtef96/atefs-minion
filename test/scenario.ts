import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NotesFile } from "../src/core/inputs.js";
import { json, type Responder } from "./helpers.js";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "samples");

export async function sample(...names: string[]): Promise<NotesFile[]> {
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(SAMPLES, name), "utf8") })));
}

const action = (title: string, type: "Task" | "UserStory", decided: boolean, quote: string, extra: object = {}) => ({
  title, type, owner: null, due: null, summary: `${title}.`, quotes: [{ text: quote, speaker: "Lena Hoffmann", timestamp: "00:02:10" }],
  decided, confidence: decided ? 0.9 : 0.3, otherTarget: null, ...extra,
});

/** What a well-behaved Gemini would extract from each sample meeting. */
export const ACTIONS: Record<string, object[]> = {
  "Planning 2026-11-03": [
    action("Mention env variable in missing mandatory option error", "Task", true, "if the option has an env variable, the error should name it", { owner: "Lena Hoffmann" }),
    action("Add opt-in JSON help output", "UserStory", true, "Yes, opt-in, on the Help class.", { owner: "Tom Becker" }),
    action("Add regression tests for Did-you-mean suggestions", "Task", true, "let's add a proper regression suite this iteration"),
    action("Drop Node 20 support", "Task", false, "Fine, we wait."),
  ],
  "Grooming 2026-11-10": [
    action("Design a plugin system for custom option types", "UserStory", false, "Just an idea, not a proposal yet"),
    action("Rewrite the help formatter in TypeScript", "Task", false, "maybe later then"),
    action("Add colour to the help output", "UserStory", false, "Let's park it."),
  ],
  "Sprint Review 2026-11-17": [
    action("Tell users which environment variable to set when a mandatory option is missing", "Task", true, "the message should tell you which environment variable you can set instead"),
    action("Reject options that share the same environment variable", "Task", true, "Let's throw for that too when the option is added."),
  ],
  "Team sync 2026-11-20": [
    action("Write release announcement post", "Task", true, "I'll write a short post with the highlights", { owner: "Priya Nair" }),
  ],
};

const REFS: Record<string, object[]> = {
  "Mention env variable in missing mandatory option error": [
    { path: "lib/command.js", startLine: 100, endLine: 110, symbol: "missingMandatoryOptionValue", why: "Builds the error message." },
    { path: "lib/does-not-exist.js", startLine: 1, endLine: 3, symbol: null, why: "hallucinated" },
  ],
  "Add opt-in JSON help output": [{ path: "lib/help.js", startLine: 10, endLine: 30, symbol: "formatHelp", why: "Help formatting." }],
  "Tell users which environment variable to set when a mandatory option is missing": [
    { path: "lib/command.js", startLine: 100, endLine: 110, symbol: "missingMandatoryOptionValue", why: "Builds the error message." },
    { path: "lib/option.js", startLine: 1, endLine: 5, symbol: "envVar", why: "Where the env variable is stored." },
  ],
  "Reject options that share the same environment variable": [{ path: "lib/option.js", startLine: 5, endLine: 15, symbol: "env", why: "Registers env variables." }],
};

function jsonBlocks(prompt: string): unknown[] {
  return [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => {
    try {
      return JSON.parse(m[1]!);
    } catch {
      return null;
    }
  });
}

export interface ScenarioOptions {
  /** Return invalid output this many times for P3 before a valid answer. */
  p3Failures?: number;
}

/** Scripted Gemini: answers the system prompt and P1–P4 like a well-behaved model would. */
export function scenario(opts: ScenarioOptions = {}): Responder & { calls: Record<string, number> } {
  const calls: Record<string, number> = { system: 0, P1: 0, P2: 0, P3: 0, P4: 0, retry: 0 };
  let p3Failures = opts.p3Failures ?? 0;
  let lastTask = "";
  const fn = ((prompt: string) => {
    if (prompt.includes("did not match the required JSON format")) {
      calls["retry"]! += 1;
      prompt = lastTask;
    }
    if (prompt.includes('Acknowledge with exactly this JSON')) {
      calls["system"]! += 1;
      return json({ ready: true });
    }
    lastTask = prompt;
    if (prompt.includes("# Task P1")) {
      calls["P1"]! += 1;
      const meeting = /Meeting: "([^"]+)"/.exec(prompt)![1]!;
      return "Here you go:\n" + json({ actions: ACTIONS[meeting] ?? [] });
    }
    if (prompt.includes("# Task P2")) {
      calls["P2"]! += 1;
      const title = /Action item: "([^"]+)"/.exec(prompt)![1]!;
      return json({ refs: REFS[title] ?? [] });
    }
    if (prompt.includes("# Task P3")) {
      calls["P3"]! += 1;
      if (p3Failures > 0) {
        p3Failures -= 1;
        return "I think the ticket should be about env variables."; // not JSON
      }
      const a = jsonBlocks(prompt)[0] as { title: string; type: string; summary: string };
      return json({
        title: a.title,
        type: a.type,
        objective: `Problem: ${a.summary} Proposed Solution: implement it.`,
        inScope: [a.title],
        outOfScope: [],
        dependencies: [],
        acceptanceCriteria: a.title.includes("environment variable")
          ? ["Error names the environment variable", "Works for options on parent commands"]
          : [`${a.title} is done`],
        dod: [7, 8, 11],
        deliverables: ["Merged pull request"],
      });
    }
    if (prompt.includes("# Task P4")) {
      calls["P4"]! += 1;
      const [draft, candidates] = jsonBlocks(prompt) as [{ title: string }, { id: string; title: string }[]];
      const isEnvError = (t: string) => /env(ironment)? variable/i.test(t) && /mandatory/i.test(t);
      const match = isEnvError(draft.title) ? candidates.find((c) => isEnvError(c.title)) : undefined;
      return json(match
        ? { duplicateOf: match.id, confidence: 0.9, reason: "Both ask to name the env variable in the missing mandatory option error." }
        : { duplicateOf: null, confidence: 0.8, reason: "Different work." });
    }
    throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
  }) as Responder & { calls: Record<string, number> };
  fn.calls = calls;
  return fn;
}
