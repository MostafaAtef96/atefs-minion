import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MinionConfig } from "../src/core/config.js";
import type { AgentFactory, AgentSession } from "../src/control/session.js";

export async function tempDir(prefix = "minion-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function testConfig(root: string, overrides: Partial<MinionConfig> = {}): MinionConfig {
  return MinionConfig.parse({
    outDir: path.join(root, "out"),
    stateDir: path.join(root, "state"),
    maxRetries: 1,
    ...overrides,
  });
}

export type Responder = (prompt: string, cwd: string) => string | Promise<string>;

/** Scripted stand-in for Gemini CLI: answers prompts with a responder function. */
export class FakeAgentFactory implements AgentFactory {
  prompts: string[] = [];
  opened: string[] = [];
  closed = 0;
  constructor(private readonly responder: Responder) {}
  async open(cwd: string): Promise<AgentSession> {
    this.opened.push(cwd);
    return {
      prompt: async (text) => {
        this.prompts.push(text);
        return this.responder(text, cwd);
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

export const json = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

const LINES = (n: number, label: string) => Array.from({ length: n }, (_, i) => `// ${label} line ${i + 1}`).join("\n") + "\n";

/** Small git repo that mimics the layout of commander.js (offline, deterministic). */
export async function makeRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "lib"), { recursive: true });
  await writeFile(path.join(repo, "lib", "command.js"), LINES(120, "command"));
  await writeFile(path.join(repo, "lib", "help.js"), LINES(60, "help"));
  await writeFile(path.join(repo, "lib", "option.js"), LINES(40, "option"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://github.com/tj/commander.js.git");
  return repo;
}
