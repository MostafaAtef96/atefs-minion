import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeRef, VerifiedRef } from "./schemas.js";

export const MAX_REF_SPAN = 400;
export const MAX_END_OVERSHOOT = 3;

export function permalink(repo: string, sha: string, filePath: string, start: number, end: number): string {
  const anchor = start === end ? `L${start}` : `L${start}-L${end}`;
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${sha}/${encoded}#${anchor}`;
}

/** Normalise an LLM-provided path to a repo-relative POSIX path, or null if it escapes the repo. */
export function normalizeRefPath(srcPath: string, p: string): string | null {
  const cleaned = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const abs = path.resolve(srcPath, cleaned);
  const rel = path.relative(path.resolve(srcPath), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export interface RefCheckResult {
  verified: VerifiedRef[];
  dropped: { ref: CodeRef; reason: string }[];
  adjusted: { ref: CodeRef; reason: string }[];
}

/**
 * Keep only references to files tracked at HEAD whose line ranges exist.
 * This is the guard against hallucinated code references (plan §4.1 rule 3).
 */
export async function verifyRefs(opts: {
  refs: CodeRef[];
  srcPath: string;
  repo: string;
  sha: string | null;
  tracked: Set<string>;
}): Promise<RefCheckResult> {
  const verified: VerifiedRef[] = [];
  const dropped: RefCheckResult["dropped"] = [];
  const adjusted: RefCheckResult["adjusted"] = [];
  const seen = new Set<string>();
  for (const ref of opts.refs) {
    const rel = normalizeRefPath(opts.srcPath, ref.path);
    if (!rel) {
      dropped.push({ ref, reason: "path outside repository" });
      continue;
    }
    if (!opts.tracked.has(rel)) {
      dropped.push({ ref, reason: "file not tracked at HEAD" });
      continue;
    }
    if (!opts.sha) {
      dropped.push({ ref, reason: "no commit SHA for permalink" });
      continue;
    }
    let lineCount: number;
    try {
      const text = await readFile(path.join(opts.srcPath, rel), "utf8");
      lineCount = text.split(/\r?\n/).length;
      if (text.endsWith("\n")) lineCount -= 1;
    } catch {
      dropped.push({ ref, reason: "file not readable" });
      continue;
    }
    const { startLine } = ref;
    let { endLine } = ref;
    // Models sometimes count one or two lines past the end of a file: trim instead of dropping.
    if (startLine <= lineCount && endLine > lineCount && endLine - lineCount <= MAX_END_OVERSHOOT) {
      adjusted.push({ ref, reason: `end line ${endLine} trimmed to ${lineCount} (end of file)` });
      endLine = lineCount;
    }
    if (startLine > endLine || endLine > lineCount) {
      dropped.push({ ref, reason: `line range ${startLine}-${endLine} invalid (file has ${lineCount} lines)` });
      continue;
    }
    if (endLine - startLine + 1 > MAX_REF_SPAN) {
      dropped.push({ ref, reason: `line range too large (> ${MAX_REF_SPAN} lines)` });
      continue;
    }
    const key = `${rel}#${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push({
      ...ref,
      endLine,
      path: rel,
      permalink: permalink(opts.repo, opts.sha, rel, startLine, endLine),
    });
  }
  return { verified, dropped, adjusted };
}
