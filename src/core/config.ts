import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const MinionConfig = z.object({
  /** Command used to start Gemini CLI. On Windows "gemini" resolves to gemini.cmd. */
  geminiCommand: z.string().default("gemini"),
  /** Arguments that put Gemini CLI in ACP mode. Older versions use "--experimental-acp". */
  geminiArgs: z.array(z.string()).default(["--acp"]),
  /** Optional Gemini model (passed as -m <model>). */
  model: z.string().nullish(),
  /** Where approved drafts are written. */
  outDir: z.string().default("out"),
  /** Ledger + pending runs live here. */
  stateDir: z.string().default(path.join(os.homedir(), ".atefs-minion")),
  defaultRepo: z.string().nullish(),
  /** Retries when Gemini returns output that does not match the expected JSON schema. */
  maxRetries: z.number().int().min(0).max(5).default(2),
  /** Write prompts/responses to run.log. */
  logPrompts: z.boolean().default(true),
  /** Timeout for a single prompt turn, in seconds. */
  promptTimeoutSec: z.number().int().min(10).default(600),
  /** Max earlier drafts compared semantically (L3) per new draft. */
  dedupMaxCandidates: z.number().int().min(1).default(50),
  /** Port of the local web form. */
  webPort: z.number().int().min(1).max(65535).default(4711),
});
export type MinionConfig = z.infer<typeof MinionConfig>;

export const CONFIG_FILE = "minion.config.json";

/** Load config from an explicit path, or ./minion.config.json if present, else defaults. */
export function loadConfig(explicitPath?: string, cwd = process.cwd()): MinionConfig {
  const file = explicitPath ? path.resolve(cwd, explicitPath) : path.join(cwd, CONFIG_FILE);
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch (e) {
      throw new Error(`Cannot parse ${file}: ${(e as Error).message}`);
    }
  } else if (explicitPath) {
    throw new Error(`Config file not found: ${file}`);
  }
  const parsed = MinionConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg = parsed.data;
  return { ...cfg, outDir: path.resolve(cwd, cfg.outDir), stateDir: path.resolve(cwd, cfg.stateDir) };
}
