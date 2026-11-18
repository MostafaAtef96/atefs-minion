import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** File/URL-safe slug, e.g. "Sprint Review 2026-11-05" -> "sprint-review-2026-11-05". */
export function slugify(input: string, max = 60): string {
  let slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > max) {
    const cut = slug.slice(0, max + 1);
    const lastDash = cut.lastIndexOf("-");
    // cut at a word boundary when that keeps most of the length
    slug = lastDash > max / 2 ? cut.slice(0, lastDash) : slug.slice(0, max);
  }
  return slug.replace(/-+$/g, "") || "untitled";
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "at", "by", "with",
  "from", "into", "be", "is", "are", "we", "should", "need", "needs", "must", "will",
  "please", "it", "its", "this", "that", "as",
]);

/** Order-insensitive normalisation used for exact-duplicate fingerprints (layer L2). */
export function normalizeTitle(title: string): string {
  const tokens = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

export function fingerprint(repo: string, title: string): string {
  return sha256(`${repo.toLowerCase()}|${normalizeTitle(title)}`).slice(0, 16);
}

export function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** Normalised form used to de-duplicate list items when merging drafts. */
export function normalizeItem(item: string): string {
  return item.toLowerCase().replace(/\s+/g, " ").trim();
}

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * Canonical repository id. github.com repositories stay "owner/name"; repositories on other GitHub servers
 * (GitHub Enterprise) become "host/owner/name". Accepts "owner/name", "host/owner/name", a web URL
 * ("https://host/owner/name", optionally with ".git" or more path) or an SSH remote ("git@host:owner/name.git").
 * Returns null when the input is not a repository.
 */
export function normalizeRepo(input: string): string | null {
  let s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let host = "github.com";
  let parts: string[];
  const ssh = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (ssh) {
    host = ssh[1]!;
    parts = ssh[2]!.split("/");
  } else if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    host = url.host;
    parts = url.pathname.split("/").filter(Boolean);
  } else {
    parts = s.split("/").filter(Boolean);
    if (parts.length === 3 && HOST.test(parts[0]!)) host = parts.shift()!;
    else if (parts.length !== 2) return null;
  }
  const [owner, name] = parts.map((p) => p.replace(/\.git$/, ""));
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name) || !HOST.test(host)) return null;
  host = host.toLowerCase().replace(/^www\./, "");
  return host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

/** Web address of a canonical repository id, e.g. "https://github.com/owner/name". */
export function repoWebUrl(repo: string): string {
  return repo.split("/").length === 3 ? `https://${repo}` : `https://github.com/${repo}`;
}
