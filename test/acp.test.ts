import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentAuthError, GeminiAgentFactory } from "../src/control/acp.js";
import { tempDir } from "./helpers.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-gemini.mjs");

function factory(extra: Partial<ConstructorParameters<typeof GeminiAgentFactory>[0]> = {}) {
  return new GeminiAgentFactory({ command: process.execPath, args: [FAKE, "--acp"], timeoutMs: 10_000, ...extra });
}

describe("Gemini CLI over ACP (fake agent on stdio)", () => {
  it("runs a prompt turn, enforces the read-only policy and collects streamed text", async () => {
    const cwd = await tempDir();
    const activity: string[] = [];
    const transcript: string[] = [];
    const session = await factory({
      model: "gemini-test",
      onActivity: (a) => activity.push(a),
      onTranscript: (role, text) => transcript.push(`${role}: ${text}`),
    }).open(cwd);
    try {
      const reply = JSON.parse(await session.prompt("hello"));
      expect(reply.edit).toEqual({ outcome: "selected", optionId: "no" });
      expect(reply.read).toEqual({ outcome: "selected", optionId: "yes" });
      expect(reply.args).toEqual(["--acp", "-m", "gemini-test"]);
      expect(path.resolve(reply.cwd)).toBe(path.resolve(cwd));
      expect(activity.some((a) => a.includes("denied") && a.includes("WriteFile"))).toBe(true);
      expect(transcript.some((t) => t.startsWith("event: permission DENIED"))).toBe(true);
      // second turn on the same session works and starts with an empty buffer
      expect(JSON.parse(await session.prompt("again")).read.outcome).toBe("selected");
    } finally {
      await session.close();
    }
  });

  it("reports a missing login clearly", async () => {
    process.env["FAKE_AUTH_FAIL"] = "1";
    try {
      await expect(factory().open(await tempDir())).rejects.toBeInstanceOf(AgentAuthError);
    } finally {
      delete process.env["FAKE_AUTH_FAIL"];
    }
  });

  it("explains how to install Gemini CLI when the command is missing", async () => {
    const f = new GeminiAgentFactory({ command: "definitely-not-gemini-xyz", args: ["--acp"], timeoutMs: 5000 });
    await expect(f.open(await tempDir())).rejects.toThrow(process.platform === "win32" ? /exited|Cannot start/ : /Install Gemini CLI/);
  });
});

describe("prompt timeout", () => {
  it("cancels a turn that takes too long", async () => {
    const session = await factory({ timeoutMs: 300 }).open(await tempDir());
    try {
      await expect(session.prompt("HANG please")).rejects.toThrow(/did not answer within/);
    } finally {
      await session.close();
    }
  });
});
