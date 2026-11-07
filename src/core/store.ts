import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ledger, PendingRun } from "./schemas.js";

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

export function emptyLedger(): Ledger {
  return { version: 1, meetings: {}, drafts: {} };
}

/** Local state: the de-duplication ledger and runs waiting for review. */
export class Store {
  constructor(public readonly stateDir: string) {}

  get ledgerFile(): string {
    return path.join(this.stateDir, "ledger.json");
  }

  pendingFile(meetingId: string): string {
    return path.join(this.stateDir, "pending", `${meetingId}.json`);
  }

  pendingLogFile(meetingId: string): string {
    return path.join(this.stateDir, "pending", `${meetingId}.log`);
  }

  async loadLedger(): Promise<Ledger> {
    if (!existsSync(this.ledgerFile)) return emptyLedger();
    const raw = JSON.parse(await readFile(this.ledgerFile, "utf8"));
    return Ledger.parse(raw);
  }

  async saveLedger(ledger: Ledger): Promise<void> {
    await writeAtomic(this.ledgerFile, JSON.stringify(Ledger.parse(ledger), null, 2));
  }

  async savePending(run: PendingRun): Promise<void> {
    await writeAtomic(this.pendingFile(run.meetingId), JSON.stringify(PendingRun.parse(run), null, 2));
  }

  async loadPending(meetingId: string): Promise<PendingRun> {
    const file = this.pendingFile(meetingId);
    if (!existsSync(file)) throw new Error(`No pending review for meeting "${meetingId}".`);
    return PendingRun.parse(JSON.parse(await readFile(file, "utf8")));
  }

  async listPending(): Promise<PendingRun[]> {
    const dir = path.join(this.stateDir, "pending");
    if (!existsSync(dir)) return [];
    const runs: PendingRun[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        runs.push(PendingRun.parse(JSON.parse(await readFile(path.join(dir, f), "utf8"))));
      } catch {
        // ignore corrupt entries
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deletePending(meetingId: string): Promise<void> {
    await rm(this.pendingFile(meetingId), { force: true });
    await rm(this.pendingLogFile(meetingId), { force: true });
  }
}

export { writeAtomic };
