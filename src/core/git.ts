import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface GitInfo {
  isRepo: boolean;
  headSha: string | null;
  dirty: boolean;
  /** HEAD is contained in at least one remote-tracking branch or tag (so permalinks resolve). */
  onRemote: boolean;
  originUrl: string | null;
}

export async function readGitInfo(srcPath: string): Promise<GitInfo> {
  const top = await git(srcPath, ["rev-parse", "--is-inside-work-tree"]);
  if (top !== "true") {
    return { isRepo: false, headSha: null, dirty: false, onRemote: false, originUrl: null };
  }
  const headSha = await git(srcPath, ["rev-parse", "HEAD"]);
  const status = await git(srcPath, ["status", "--porcelain"]);
  const contains = headSha
    ? await git(srcPath, ["for-each-ref", "--contains", headSha, "--format=%(refname)", "refs/remotes", "refs/tags"])
    : null;
  const originUrl = await git(srcPath, ["remote", "get-url", "origin"]);
  return {
    isRepo: true,
    headSha,
    dirty: Boolean(status),
    onRemote: Boolean(contains),
    originUrl,
  };
}

/** Files tracked by git at HEAD (repo-relative, forward slashes). */
export async function listTrackedFiles(srcPath: string): Promise<Set<string>> {
  const out = await git(srcPath, ["ls-files", "-z"]);
  if (!out) return new Set();
  return new Set(out.split("\0").filter(Boolean));
}

/** True when `originUrl` points at github.com/<repo> (https or ssh form). */
export function originMatchesRepo(originUrl: string, repo: string): boolean {
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(originUrl.trim());
  return Boolean(m && m[1]!.toLowerCase() === repo.toLowerCase());
}
