import type { ToolSchema } from '../types'
import type { ToolDef } from './types'
import { shell, readShell, writeShell, stopShell, listShells } from './shell'
import { webFetch } from './web'
import { sql } from './sql'
import { readFile, writeFile, editFile, glob } from './fs-tools'
import { grep } from './grep'
import { skill, askUser, task, readAgent, listAgents } from './agent-tools'

export const ALL_TOOLS: ToolDef[] = [shell, readShell, writeShell, stopShell, listShells, readFile, writeFile, editFile, glob, grep, webFetch, sql, skill, askUser, task, readAgent, listAgents]
const AGENT_TOOLS = new Set(['task', 'read_agent', 'list_agents'])
export const MAX_DEPTH = 2

/** Maps Copilot-style agent `tools:` aliases to concrete tool names. */
const ALIASES: Record<string, string[]> = {
  read: ['read_file', 'glob', 'grep'],
  view: ['read_file'],
  search: ['glob', 'grep'],
  edit: ['write_file', 'edit_file'],
  create: ['write_file'],
  write: ['write_file', 'edit_file'],
  execute: ['shell', 'read_shell', 'write_shell', 'stop_shell', 'list_shells'],
  shell: ['shell', 'read_shell', 'write_shell', 'stop_shell', 'list_shells'],
  bash: ['shell', 'read_shell', 'write_shell', 'stop_shell', 'list_shells'],
  web: ['web_fetch'],
  fetch: ['web_fetch'],
  web_fetch: ['web_fetch'],
  sql: ['sql'],
  todo: ['sql'],
  agent: ['task', 'read_agent', 'list_agents'],
  task: ['task', 'read_agent', 'list_agents']
}

export function selectTools(agentTools: string[] | undefined, depth: number): ToolDef[] {
  let names: Set<string>
  if (!agentTools || agentTools.includes('*')) names = new Set(ALL_TOOLS.map((t) => t.name))
  else {
    names = new Set(['skill', 'ask_user'])
    for (const t of agentTools) for (const n of ALIASES[t] ?? [t]) names.add(n)
  }
  if (depth >= MAX_DEPTH) for (const n of AGENT_TOOLS) names.delete(n)
  return ALL_TOOLS.filter((t) => names.has(t.name))
}

export function toSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}
