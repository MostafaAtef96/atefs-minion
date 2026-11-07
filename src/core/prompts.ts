import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prompts");

export type PromptName = "system" | "p1-extract" | "p2-code" | "p3-draft" | "p4-dedup";

const cache = new Map<PromptName, string>();

export function loadPrompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf8");
    cache.set(name, text);
  }
  return text;
}

/** Fill {{placeholders}}. Values are inserted verbatim (single pass, so inserted text is never re-expanded). */
export function renderPrompt(name: PromptName, vars: Record<string, string | number>): string {
  return loadPrompt(name).replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt ${name}: missing variable "${key}"`);
    return String(vars[key]);
  });
}
