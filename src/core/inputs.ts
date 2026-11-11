import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { REPO_PATTERN, sha256, slugify } from "./text.js";

export interface NotesFile {
  name: string;
  content: string;
}

export interface RunInputs {
  notes: NotesFile[];
  srcPath: string;
  meetingTitle: string;
  repo: string;
  force?: boolean;
}

export const MAX_NOTES_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".vtt", ".sbv", ""]);

/** Read notes/transcript files given as paths (CLI). The web form sends contents directly. */
export async function readNotesFiles(paths: string[]): Promise<NotesFile[]> {
  const files: NotesFile[] = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      throw new Error(
        `${p}: unsupported format "${ext}". Export the Google Doc via File → Download as Markdown (.md) or Plain text (.txt).`,
      );
    }
    const s = await stat(p).catch(() => null);
    if (!s?.isFile()) throw new Error(`Notes file not found: ${p}`);
    if (s.size > MAX_NOTES_BYTES) throw new Error(`${p} is larger than 2 MB.`);
    const content = (await readFile(p, "utf8")).replace(/^﻿/, "");
    files.push({ name: path.basename(p), content });
  }
  return files;
}

export interface ValidatedInputs extends RunInputs {
  meetingId: string;
  inputHash: string;
  srcPath: string;
}

export async function validateInputs(inputs: RunInputs): Promise<ValidatedInputs> {
  const errors: string[] = [];
  const notes = inputs.notes.filter((n) => n.content.trim().length > 0);
  if (notes.length === 0) errors.push("At least one non-empty notes/transcript file is required.");
  const total = notes.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > MAX_NOTES_BYTES) errors.push("Notes/transcript content is larger than 2 MB.");
  const title = inputs.meetingTitle.trim();
  if (!title) errors.push("Meeting title is required.");
  const repo = inputs.repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!REPO_PATTERN.test(repo)) errors.push(`GitHub repo must look like "owner/name" (got "${inputs.repo}").`);
  const srcPath = path.resolve(inputs.srcPath.trim() || ".");
  const s = await stat(srcPath).catch(() => null);
  if (!s?.isDirectory()) errors.push(`Source code path is not a directory: ${srcPath}`);
  if (errors.length) throw new InputError(errors);

  const inputHash = sha256(
    notes
      .map((n) => n.content.replace(/\r\n/g, "\n").trim())
      .sort()
      .join("\n\u0000\n"),
  ).slice(0, 32);
  return { ...inputs, notes, meetingTitle: title, repo, srcPath, meetingId: slugify(title), inputHash };
}

export class InputError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "InputError";
  }
}
