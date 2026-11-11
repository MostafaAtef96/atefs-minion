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
