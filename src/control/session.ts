/** A conversation with the LLM agent. The real implementation drives Gemini CLI over ACP. */
export interface AgentSession {
  /** Send one prompt turn and return the agent's full text reply. */
  prompt(text: string): Promise<string>;
  close(): Promise<void>;
}

export interface AgentFactory {
  /** Open a session whose working directory is the source code path. */
  open(cwd: string): Promise<AgentSession>;
}
