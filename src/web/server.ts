import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentFactory } from "../control/session.js";
import type { MinionConfig } from "../core/config.js";
import { DOD_CRITERIA } from "../core/dod.js";
import { FIELD_LABELS, finalize, linkIssue, mergeCandidates, readRecap, type ListField } from "../core/finalize.js";
import { InputError } from "../core/inputs.js";
import { generate } from "../core/pipeline.js";
import { renderDraftFile } from "../core/render.js";
import { ReviewDecision, TicketContent } from "../core/schemas.js";
import { Store } from "../core/store.js";
import { shortId } from "../core/text.js";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const MAX_BODY = 6 * 1024 * 1024;

const RunRequest = z.object({
  notes: z.array(z.object({ name: z.string(), content: z.string() })).min(1),
  src: z.string().min(1),
  meeting: z.string().min(1),
  repo: z.string().min(1),
  force: z.boolean().optional(),
});
const FinalizeRequest = z.object({ decisions: z.record(z.string(), ReviewDecision) });
const PreviewRequest = z.object({ draftId: z.string(), content: TicketContent });
const LinkRequest = z.object({ url: z.string() });

interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: string[];
  meetingId?: string;
  error?: string;
}

export interface WebServerOptions {
  config: MinionConfig;
  port: number;
  agents: (onActivity: (message: string) => void) => AgentFactory;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error));
  return r.data;
}

/** Local-only web form + review table. Binds to 127.0.0.1 and rejects foreign Host/Origin headers. */
export async function startWebServer(opts: WebServerOptions): Promise<{ url: string; server: http.Server }> {
  const { config } = opts;
  const store = new Store(config.stateDir);
  const jobs = new Map<string, Job>();
  let port = opts.port;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
    const origin = req.headers.origin;
    if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) throw new HttpError(403, "Forbidden origin");

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(WEB_DIR, "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        "x-frame-options": "DENY",
      });
      res.end(html);
      return;
    }
    // out/<meeting>/index.html of a processed meeting (looked up in the ledger, never a free path)
    if (req.method === "GET" && parts[0] === "out" && parts[1] && parts.length === 2) {
      const meeting = (await store.loadLedger()).meetings[decodeURIComponent(parts[1])];
      if (!meeting?.outDir) throw new HttpError(404, "No output for this meeting");
      const html = await readFile(path.join(meeting.outDir, "index.html")).catch(() => {
        throw new HttpError(404, "No output for this meeting");
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "SAMEORIGIN" });
      res.end(html);
      return;
    }
    if (parts[0] !== "api") throw new HttpError(404, "Not found");

    if (req.method === "GET" && url.pathname === "/api/info") {
      return send(res, 200, { defaultRepo: config.defaultRepo ?? "", dod: DOD_CRITERIA, outDir: config.outDir });
    }

    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = parse(RunRequest, await readJson(req));
      const job: Job = { id: shortId(), status: "running", progress: [] };
      jobs.set(job.id, job);
      const note = (m: string) => job.progress.push(m);
      generate(
        { notes: body.notes, srcPath: body.src, meetingTitle: body.meeting, repo: body.repo, force: body.force },
        { agents: opts.agents((a) => note(`  ↳ ${a}`)), store, config, onProgress: note },
      ).then(
        (run) => Object.assign(job, { status: "done", meetingId: run.meetingId }),
        (e: Error) => Object.assign(job, { status: "error", error: e instanceof InputError ? e.problems.join("\n") : e.message }),
      );
      return send(res, 202, { jobId: job.id });
    }

    if (req.method === "GET" && parts[1] === "recap" && parts[2]) {
      const recap = await readRecap(store, decodeURIComponent(parts[2])).catch((e: Error) => {
        throw new HttpError(404, e.message);
      });
      return send(res, 200, { markdown: recap });
    }

    if (req.method === "POST" && parts[1] === "drafts" && parts[2] && parts[3] === "issue") {
      const body = parse(LinkRequest, await readJson(req));
      const r = await linkIssue(store, decodeURIComponent(parts[2]), body.url).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      return send(res, 200, r);
    }

    if (req.method === "GET" && parts[1] === "jobs" && parts[2]) {
      const job = jobs.get(parts[2]);
      if (!job) throw new HttpError(404, "Unknown job");
      return send(res, 200, job);
    }

    if (req.method === "GET" && url.pathname === "/api/pending") {
      const runs = await store.listPending();
      return send(res, 200, runs.map((r) => ({ meetingId: r.meetingId, meetingTitle: r.meetingTitle, repo: r.repo, drafts: r.drafts.length, createdAt: r.createdAt })));
    }

    if (parts[1] === "pending" && parts[2]) {
      const meetingId = decodeURIComponent(parts[2]);
      const run = await store.loadPending(meetingId).catch((e: Error) => {
        throw new HttpError(404, e.message);
      });
      if (req.method === "GET" && parts.length === 3) {
        const ledger = await store.loadLedger();
        const duplicates = Object.fromEntries(
          run.drafts
            .filter((p) => p.dedup.status === "duplicate" && p.dedup.duplicateOf && ledger.drafts[p.dedup.duplicateOf])
            .map((p) => {
              const target = ledger.drafts[p.dedup.duplicateOf!]!;
              const c = mergeCandidates(target, p.draft);
              return [p.draft.id, {
                id: target.id,
                title: target.content.title,
                meetings: target.sources.map((s) => s.meetingTitle),
                candidates: {
                  lists: Object.entries(c.lists).map(([field, items]) => ({ field, label: FIELD_LABELS[field as ListField], items })),
                  refs: c.refs.map((r) => ({ permalink: r.permalink, label: `${r.path}#L${r.startLine}-L${r.endLine}${r.symbol ? ` (${r.symbol})` : ""}`, why: r.why })),
                },
                existingMarkdown: renderDraftFile(target),
              }];
            }),
        );
        return send(res, 200, { run, duplicates });
      }
      if (req.method === "POST" && parts[3] === "preview") {
        const body = parse(PreviewRequest, await readJson(req));
        const p = run.drafts.find((d) => d.draft.id === body.draftId);
        if (!p) throw new HttpError(404, "Unknown draft");
        return send(res, 200, { markdown: renderDraftFile({ ...p.draft, content: body.content }) });
      }
      if (req.method === "POST" && parts[3] === "finalize") {
        const body = parse(FinalizeRequest, await readJson(req));
        const result = await finalize(run, body.decisions, { store, config }).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        return send(res, 200, result);
      }
    }
    throw new HttpError(404, "Not found");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") port = addr.port;
  return { url: `http://127.0.0.1:${port}/`, server };
}
