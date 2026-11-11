import http from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startWebServer } from "../src/web/server.js";
import { FakeAgentFactory, makeRepo, tempDir, testConfig } from "./helpers.js";
import { sample, scenario } from "./scenario.js";

let close: (() => void) | null = null;
afterEach(() => close?.());

function request(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode!, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("local web form", () => {
  it("runs the pipeline, shows the review and finalizes decisions", async () => {
    const root = await tempDir();
    const repo = await makeRepo(root);
    const config = testConfig(root, { defaultRepo: "tj/commander.js" });
    const { url, server } = await startWebServer({ config, port: 0, agents: () => new FakeAgentFactory(scenario()) });
    close = () => server.close();

    const page = await request(url, "GET");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Atef's Minion");

    expect((await request(`${url}api/info`, "GET")).json).toMatchObject({ defaultRepo: "tj/commander.js" });
    expect((await request(`${url}api/runs`, "POST", { notes: [], src: repo, meeting: "x", repo: "a/b" })).status).toBe(400);

    const notes = await sample("01-planning-2026-11-03.md");
    const started = await request(`${url}api/runs`, "POST", { notes, src: repo, meeting: "Planning 2026-11-03", repo: "tj/commander.js" });
    expect(started.status).toBe(202);
    let job: any;
    for (let i = 0; i < 50; i++) {
      job = (await request(`${url}api/jobs/${started.json.jobId}`, "GET")).json;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ status: "done", meetingId: "planning-2026-11-03" });
    expect(job.progress.join("\n")).toContain("3 draft(s) ready for review");

    const pendingList = (await request(`${url}api/pending`, "GET")).json;
    expect(pendingList).toMatchObject([{ meetingId: "planning-2026-11-03", drafts: 3 }]);
    const { run } = (await request(`${url}api/pending/planning-2026-11-03`, "GET")).json;

    const [a, b, c] = run.drafts.map((d: any) => d.draft);
    const preview = await request(`${url}api/pending/planning-2026-11-03/preview`, "POST", { draftId: a.id, content: { ...a.content, title: "Edited title" } });
    expect(preview.json.markdown).toMatch(/^# Edited title/);

    const fin = await request(`${url}api/pending/planning-2026-11-03/finalize`, "POST", {
      decisions: {
        [a.id]: { action: "approve", content: { ...a.content, title: "Edited title" } },
        [b.id]: { action: "approve" },
        [c.id]: { action: "reject" },
      },
    });
    expect(fin.status).toBe(200);
    expect(fin.json.written.map((w: any) => w.title)).toEqual(["Edited title", "Add opt-in JSON help output"]);
    expect(await readFile(fin.json.written[0].file, "utf8")).toMatch(/^# Edited title/);
    expect((await request(`${url}api/pending`, "GET")).json).toEqual([]);
    expect(fin.json.written[0].issueUrl).toContain("/issues/new?title=Edited%20title");
    const index = await request(`${url}out/planning-2026-11-03`, "GET");
    expect(index.status).toBe(200);
    expect(index.text).toContain("Open as GitHub issue");
    expect((await request(`${url}out/..%2F..%2Fetc`, "GET")).status).toBe(404);

    const recap = await request(`${url}api/recap/planning-2026-11-03`, "GET");
    expect(recap.json.markdown).toContain("1. Edited title");
    const bad = await request(`${url}api/drafts/${a.id}/issue`, "POST", { url: "nope" });
    expect(bad.status).toBe(400);
    const ok = await request(`${url}api/drafts/${a.id}/issue`, "POST", { url: "https://github.com/tj/commander.js/issues/5" });
    expect(ok.status).toBe(200);
    expect((await request(`${url}api/recap/planning-2026-11-03`, "GET")).json.markdown).toContain("Ticket: https://github.com/tj/commander.js/issues/5");
  });

  it("rejects foreign hosts, origins and non-JSON posts", async () => {
    const root = await tempDir();
    const { url, server } = await startWebServer({ config: testConfig(root), port: 0, agents: () => new FakeAgentFactory(scenario()) });
    close = () => server.close();
    expect((await request(url, "GET", undefined, { host: "evil.example.com" })).status).toBe(403);
    expect((await request(`${url}api/runs`, "POST", {}, { origin: "http://evil.example.com" })).status).toBe(403);
    const plain = await new Promise<number>((resolve) => {
      const req = http.request(`${url}api/runs`, { method: "POST", headers: { "content-type": "text/plain" } }, (res) => resolve(res.statusCode!));
      req.end("{}");
    });
    expect(plain).toBe(415);
  });
});
