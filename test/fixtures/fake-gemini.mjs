#!/usr/bin/env node
// A stand-in for `gemini --acp`: speaks ACP over stdio, asks for one "edit" and one "read"
// permission per prompt turn, and replies with the outcomes it received as JSON.
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const app = agent({ name: "fake-gemini" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    authMethods: [],
    agentCapabilities: {},
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (process.env.FAKE_AUTH_FAIL) throw new RequestError(-32000, "Authentication required.");
    return { sessionId: `s-${params.cwd.length}` };
  })
  .onNotification(methods.agent.session.cancel, () => {})
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const promptText = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (promptText.includes("HANG")) return new Promise(() => {});
    if (process.env.FAKE_SCENARIO) {
      await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "w1", kind: "edit", title: "WriteFile notes.md" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ReadFile lib/command.js", kind: "read" },
      });
      const text = "```json\n" + JSON.stringify(scripted(promptText)) + "\n```";
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      return { stopReason: "end_turn" };
    }
    const ask = (kind, title) =>
      client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: title, kind, title },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
    const edit = await ask("edit", "WriteFile src/x.ts");
    const read = await ask("read", "ReadFile src/x.ts");
    const text = JSON.stringify({ cwd: process.cwd(), edit: edit.outcome, read: read.outcome, args: process.argv.slice(2) });
    for (const part of [text.slice(0, 10), text.slice(10)]) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } },
      });
    }
    return { stopReason: "end_turn" };
  });

/** Minimal well-behaved answers for the system prompt and tasks P1–P4 (CLI end-to-end test). */
function scripted(prompt) {
  if (prompt.includes("Acknowledge with exactly this JSON")) return { ready: true };
  if (prompt.includes("# Task P1")) {
    return {
      actions: [
        { title: "Write release announcement post", type: "Task", owner: "Priya Nair", due: null, summary: "Announce the next minor release.", quotes: [{ text: "I'll write a short post", speaker: "Priya Nair", timestamp: "00:01:30" }], decided: true, confidence: 0.9, otherTarget: null },
      ],
    };
  }
  if (prompt.includes("# Task P2")) return { refs: [{ path: "lib/command.js", startLine: 1, endLine: 5, symbol: null, why: "Example." }] };
  if (prompt.includes("# Task P3")) {
    return { title: "Write release announcement post", type: "Task", objective: "In order to make releases visible, we want to publish an announcement, so that users notice new features.", inScope: ["Announcement post"], outOfScope: [], dependencies: [], acceptanceCriteria: ["Post is published on release day"], dod: [], deliverables: ["Published post"] };
  }
  if (prompt.includes("# Task P4")) return { duplicateOf: null, confidence: 0.9, reason: "Different work." };
  return { error: "unexpected prompt" };
}

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
