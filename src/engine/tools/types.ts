import type { Hooks, PermissionKind, AgentStatus } from '../types'
import type { Registry } from '../registry/registry'
import type { PermissionGate } from '../permissions'
import type { ShellManager } from './shell'

export interface AgentInfo { id: string; name: string; parentId: string | null; mode: 'main' | 'sync' | 'background'; status: AgentStatus; finalText: string }

/** Operations the sub-agent tools need; implemented by AgentManager. */
export interface AgentOps {
  spawn(opts: { agent?: string; prompt: string; mode: 'sync' | 'background'; parentId: string; depth: number }): Promise<AgentInfo>
  read(id: string, wait: boolean, timeoutMs: number): Promise<AgentInfo | null>
  list(): AgentInfo[]
}

export interface ToolContext {
  cwd: string
  agentId: string
  depth: number
  signal: AbortSignal
  hooks: Hooks
  gate: PermissionGate
  registry: Registry
  agents: AgentOps
  /** Background shells for this chat (mode "async"). */
  shells?: ShellManager
  /** Per-chat folder for scratch state such as the sql tool's database. */
  stateDir?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  permission?: PermissionKind
  /** Short human summary of a call, used for approval prompts. */
  summarize?(args: any): string
  run(args: any, ctx: ToolContext): Promise<string>
}
