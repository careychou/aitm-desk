export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string }

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; args?: string }
  | { type: 'usage'; prompt: number; completion: number }
  | { type: 'finish'; reason: string }

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSchema[]
  maxTokens?: number
  /** Ask the provider to return the model's reasoning (include_reasoning + reasoning_effort). */
  reasoning?: 'off' | 'low' | 'medium' | 'high'
}

export interface ModelAdapter {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta>
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Events emitted by the engine; every event carries the agentId it belongs to. */
export type AgentEvent =
  | { kind: 'agent_start'; agentId: string; parentId: string | null; name: string; mode: 'main' | 'sync' | 'background'; prompt: string }
  | { kind: 'text'; agentId: string; text: string }
  | { kind: 'reasoning'; agentId: string; text: string }
  | { kind: 'assistant_done'; agentId: string; message: Message }
  | { kind: 'tool_start'; agentId: string; callId: string; name: string; args: string }
  | { kind: 'tool_end'; agentId: string; callId: string; name: string; output: string; ok: boolean }
  | { kind: 'agent_end'; agentId: string; status: AgentStatus; finalText: string }
  | { kind: 'usage'; agentId: string; prompt: number; completion: number }
  | { kind: 'error'; agentId: string; message: string }
  /** A prompt queued while the agent was working has just been added to the conversation. */
  | { kind: 'user_input'; agentId: string; qid: string }
  /** Queued prompts discarded because the run was stopped or failed. */
  | { kind: 'queue_cleared'; agentId: string; qids: string[] }

export type PermissionKind = 'shell' | 'write' | 'url'
export type PermissionDecision = 'allow' | 'allow_session' | 'deny'

export interface Hooks {
  onEvent(e: AgentEvent): void
  requestPermission(req: { agentId: string; kind: PermissionKind; detail: string }): Promise<PermissionDecision>
  askUser(req: { agentId: string; question: string; choices?: string[] }): Promise<string>
}
