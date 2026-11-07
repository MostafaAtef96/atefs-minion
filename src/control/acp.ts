import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type ClientConnection,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { decidePermission } from "./permissions.js";
import type { AgentFactory, AgentSession } from "./session.js";

export interface AcpSessionOptions {
  cwd: string;
  timeoutMs: number;
  /** Activity callback, e.g. "reading src/index.ts" — for progress output. */
  onActivity?: (message: string) => void;
  /** Receives every prompt/response exchanged (run.log). */
  onTranscript?: (role: "prompt" | "response" | "event", text: string) => void;
}

/** Thrown when Gemini CLI reports that it is not logged in. */
export class AgentAuthError extends Error {
  constructor(detail: string) {
    super(
      `Gemini CLI is not authenticated (${detail}). Run "gemini" once in a terminal, log in, then retry.`,
    );
    this.name = "AgentAuthError";
  }
}

/**
 * Open an ACP session over a stream (a spawned Gemini CLI) or an in-process agent (tests).
 * The client advertises no file-system write or terminal capability, and every permission
 * request goes through the read-only policy.
 */
export async function openAcpSession(target: Stream | AgentApp, opts: AcpSessionOptions): Promise<AgentSession & { connection: ClientConnection }> {
  let sessionId: string | null = null;
  let buffer = "";

  const app = client({ name: "atefs-minion" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const decision = decidePermission(params);
      const what = params.toolCall.title ?? params.toolCall.kind ?? "tool";
      opts.onTranscript?.("event", `permission ${decision.allowed ? "ALLOWED" : "DENIED"}: ${what} (${params.toolCall.kind ?? "unknown"})`);
      if (!decision.allowed) opts.onActivity?.(`denied (read-only policy): ${what}`);
      return decision.response;
    })
    .onNotification(methods.client.session.update, ({ params }: { params: SessionNotification }) => {
      if (sessionId && params.sessionId !== sessionId) return;
      const u = params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        buffer += u.content.text;
      } else if (u.sessionUpdate === "tool_call") {
        opts.onActivity?.(u.title);
        opts.onTranscript?.("event", `tool_call: ${u.title} (${u.kind ?? "other"})`);
      }
    });

  const connection = app.connect(target as Stream);

  try {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "atefs-minion", version: "0.1.0" },
    });
    const created = await connection.agent.request(methods.agent.session.new, { cwd: opts.cwd, mcpServers: [] });
    sessionId = created.sessionId;
  } catch (e) {
    connection.close();
    if (e instanceof RequestError && (e.code === -32000 || /auth/i.test(e.message))) {
      throw new AgentAuthError(e.message);
    }
    throw e;
  }

  const id = sessionId;
  return {
    connection,
    async prompt(text: string): Promise<string> {
      buffer = "";
      opts.onTranscript?.("prompt", text);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void connection.agent.notify(methods.agent.session.cancel, { sessionId: id }).catch(() => {});
        controller.abort(new Error(`Gemini did not answer within ${Math.round(opts.timeoutMs / 1000)} s`));
      }, opts.timeoutMs);
      try {
        const res = await connection.agent.request(
          methods.agent.session.prompt,
          { sessionId: id, prompt: [{ type: "text", text }] },
          { cancellationSignal: controller.signal, stopWaitingOnCancel: true },
        );
        opts.onTranscript?.("response", buffer);
        if (res.stopReason === "refusal") throw new Error("Gemini refused to answer this prompt.");
        if (res.stopReason === "cancelled") throw new Error("The prompt turn was cancelled.");
        return buffer;
      } catch (e) {
        if (controller.signal.aborted) throw controller.signal.reason as Error;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    async close(): Promise<void> {
      connection.close();
    },
  };
}

/** On Windows the shell wrapper must be killed together with the node process it started. */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    child.kill();
  }
}

/** Quote an argument for cmd.exe when spawning through the shell on Windows. */
function winQuote(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export interface GeminiOptions {
  command: string;
  args: string[];
  model?: string | null;
  timeoutMs: number;
  onActivity?: (message: string) => void;
  onTranscript?: (role: "prompt" | "response" | "event", text: string) => void;
}

/** Starts Gemini CLI in ACP mode (one process per session) with cwd = source code path. */
export class GeminiAgentFactory implements AgentFactory {
  constructor(private readonly options: GeminiOptions) {}

  async open(cwd: string): Promise<AgentSession> {
    const { command, model } = this.options;
    const args = [...this.options.args, ...(model ? ["-m", model] : [])];
    const isWin = process.platform === "win32";
    // On Windows "gemini" is a .cmd shim, which Node can only start through the shell.
    const child: ChildProcess = isWin
      ? spawn([command, ...args].map(winQuote).join(" "), { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
    });

    const exited = new Promise<never>((_, reject) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "ENOENT"
            ? new Error(`Cannot start "${command}". Install Gemini CLI (npm install -g @google/gemini-cli) or set "geminiCommand" in minion.config.json.`)
            : err,
        );
      });
      child.once("exit", (code) => {
        reject(new Error(`Gemini CLI exited (code ${code}).${stderrTail ? `\n${stderrTail.trim()}` : ""}`));
      });
    });
    exited.catch(() => {}); // observed below

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );

    let session: AgentSession & { connection: ClientConnection };
    try {
      session = await Promise.race([openAcpSession(stream, { cwd, ...this.options }), exited]);
    } catch (e) {
      killTree(child);
      throw e;
    }
    return {
      prompt: (text) => Promise.race([session.prompt(text), exited]),
      close: async () => {
        await session.close();
        killTree(child);
      },
    };
  }
}
