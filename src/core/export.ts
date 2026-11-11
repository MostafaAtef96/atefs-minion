import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_LABEL, AGENT_NAME, renderIssueBody } from "./render.js";
import type { Draft } from "./schemas.js";

/** Browsers and GitHub reliably accept URLs up to about 8 000 characters. */
export const MAX_ISSUE_URL = 8000;

export interface IssueLink {
  /** GitHub "new issue" page with the title (and, if it fits, the body) filled in. */
  url: string;
  /** False when the body was too long for the URL: it must be pasted (the page copies it to the clipboard). */
  complete: boolean;
  title: string;
  body: string;
}

/**
 * Link that opens GitHub's new-issue form pre-filled with a draft. No token is needed and nothing is
 * created until the user clicks "Submit new issue" on GitHub.
 */
export function newIssueLink(draft: Draft): IssueLink {
  const title = draft.content.title;
  const body = renderIssueBody(draft);
  const base = `https://github.com/${draft.repo}/issues/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(AGENT_LABEL)}`;
  const full = `${base}&body=${encodeURIComponent(body)}`;
  return full.length <= MAX_ISSUE_URL
    ? { url: full, complete: true, title, body }
    : { url: base, complete: false, title, body };
}

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * out/<meeting>/index.html: a self-contained page (works offline, opened by double-click) listing the
 * meeting's tickets with "Open as GitHub issue" and "Copy Markdown" buttons.
 */
export function renderIndexPage(meetingTitle: string, repo: string, drafts: Draft[], recap = ""): string {
  let mascot = "";
  try {
    mascot = readFileSync(path.join(ASSETS, "minion.svg"), "utf8").replace(/<svg /, '<svg class="logo" ');
  } catch {
    mascot = "";
  }
  const cards = drafts.map((d, i) => {
    const link = newIssueLink(d);
    const meetings = d.sources.map((s) => s.meetingTitle).join(", ");
    return `
  <article class="card">
    <div class="head"><h2>${i + 1}. ${esc(d.content.title)}</h2><span class="badge">${d.content.type === "Task" ? "Task" : "User Story"}</span></div>
    <p class="meta">Raised in: ${esc(meetings)}${d.refs.length ? ` · ${d.refs.length} code link(s)` : ""}</p>
    <div class="actions">
      ${d.issueUrl
        ? `<a class="btn" href="${esc(d.issueUrl)}" target="_blank" rel="noopener">View issue</a>`
        : `<a class="btn" href="${esc(link.url)}" target="_blank" rel="noopener" data-complete="${link.complete}">Open as GitHub issue</a>`}
      <button class="btn secondary" type="button">Copy Markdown</button>
      ${link.complete ? "" : '<span class="hint">Long ticket: the text is copied for you to paste on GitHub.</span>'}
    </div>
    <details><summary>Show the ticket text</summary><pre>${esc(link.body)}</pre></details>
  </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meetingTitle)} · ${AGENT_NAME}</title>
<style>
  :root { --bg: #f6f7f9; --panel: #fff; --text: #1d2330; --muted: #5d6676; --border: #d9dde4; --accent: #2f9e44; --accent-text: #fff; --code: #eef1f5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171c; --panel: #1c2027; --text: #e6e9ef; --muted: #9aa3b2; --border: #2e343e; --accent: #51cf66; --accent-text: #0e1116; --code: #242a33; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; gap: 14px; align-items: center; padding: 16px 24px; background: var(--panel); border-bottom: 1px solid var(--border); }
  header h1 { margin: 0; font-size: 20px; } header p { margin: 2px 0 0; color: var(--muted); }
  .logo { width: 44px; height: 44px; flex: none; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 60px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  h2 { margin: 0; font-size: 17px; } .meta { color: var(--muted); margin: 6px 0 12px; font-size: 14px; }
  .badge { border: 1px solid var(--border); border-radius: 99px; padding: 1px 9px; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .btn { display: inline-block; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text);
         font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn.secondary { background: transparent; color: var(--accent); }
  .hint { color: var(--muted); font-size: 13px; }
  details summary { cursor: pointer; color: var(--muted); margin-top: 12px; }
  pre { background: var(--code); padding: 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .note { color: var(--muted); font-size: 14px; }
</style></head>
<body>
<header>${mascot}<div><h1>${esc(meetingTitle)}</h1><p>${drafts.length} ticket draft(s) for ${esc(repo)} · drafted by ${AGENT_NAME}</p></div></header>
<main>
  ${recap ? `<section class="card recap"><div class="head"><h2>Meeting recap</h2><button class="btn secondary" type="button" id="copy-recap">Copy recap</button></div>
    <p class="meta">Ready to paste into an email or chat for the attendees. Ticket links appear once you add them with <code>minion link</code>.</p>
    <pre id="recap-text">${esc(recap)}</pre></section>` : ""}
  <p class="note">Each button opens GitHub's "New issue" page with the ticket filled in. Nothing is created until you click <b>Submit new issue</b> there.</p>
${cards || '<p class="note">No tickets were approved for this meeting.</p>'}
</main>
<script>
  const copyRecap = document.getElementById("copy-recap");
  if (copyRecap) copyRecap.addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("recap-text").textContent).catch(() => {});
    copyRecap.textContent = "Copied";
  });
  for (const card of document.querySelectorAll(".card:not(.recap)")) {
    const text = card.querySelector("pre").textContent;
    const copy = () => navigator.clipboard.writeText(text).catch(() => {});
    card.querySelector("button").addEventListener("click", async (e) => { await copy(); e.target.textContent = "Copied"; });
    const open = card.querySelector("a.btn");
    if (open.dataset.complete === "false") open.addEventListener("click", copy);
  }
</script>
</body></html>
`;
}
