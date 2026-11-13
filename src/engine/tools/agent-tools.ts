import type { ToolDef } from './types'

const fmt = (a: { id: string; name: string; status: string; finalText: string }) =>
  `agent_id: ${a.id}\nname: ${a.name}\nstatus: ${a.status}` + (a.status === 'running' ? '' : `\nresult:\n${a.finalText}`)

export const skill: ToolDef = {
  name: 'skill',
  description: 'Load the full instructions of a skill by name (from the available skills list). Call this before acting on a task the skill covers. Relative paths in the skill resolve against the returned skill directory.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run(a, ctx) {
    const s = ctx.registry.loadSkill(a.name)
    if (!s) throw new Error(`unknown skill "${a.name}". Available: ${ctx.registry.skills.map((x) => x.name).join(', ')}`)
    return `<skill name="${a.name}" dir="${s.dir}">\nBase directory for this skill: ${s.dir}\n\n${s.body}\n</skill>`
  }
}

export const askUser: ToolDef = {
  name: 'ask_user',
  description: 'Ask the user one clarifying question and wait for the answer. Provide choices when possible.',
  parameters: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
  async run(a, ctx) {
    return ctx.hooks.askUser({ agentId: ctx.agentId, question: a.question, choices: a.choices })
  }
}

export const task: ToolDef = {
  name: 'task',
  description: 'Launch a sub-agent with its own fresh context. Give it a complete, self-contained prompt. Optional "agent" picks a named agent from the available agents list (otherwise a general-purpose agent). mode "sync" (default) waits and returns the final answer; "background" returns an agent_id immediately — use read_agent to get the result. To run sub-agents in PARALLEL, emit several task calls in the same response.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      agent: { type: 'string' },
      description: { type: 'string', description: '3-5 word label for the UI' },
      mode: { type: 'string', enum: ['sync', 'background'] }
    },
    required: ['prompt']
  },
  async run(a, ctx) {
    const info = await ctx.agents.spawn({ agent: a.agent, prompt: a.prompt, mode: a.mode === 'background' ? 'background' : 'sync', parentId: ctx.agentId, depth: ctx.depth + 1 })
    if (a.mode === 'background') return `Background agent started.\nagent_id: ${info.id}\nUse read_agent to retrieve its result; you will also be notified when it completes.`
    return info.status === 'completed' ? info.finalText : `${info.status}: ${info.finalText}`
  }
}

export const readAgent: ToolDef = {
  name: 'read_agent',
  description: 'Get the status/result of a sub-agent by agent_id. Set wait=true to block until it finishes (timeout seconds, default 60, max 600).',
  parameters: { type: 'object', properties: { agent_id: { type: 'string' }, wait: { type: 'boolean' }, timeout: { type: 'integer' } }, required: ['agent_id'] },
  async run(a, ctx) {
    const t = Math.min(Math.max(Number(a.timeout) || 60, 1), 600)
    const info = await ctx.agents.read(a.agent_id, !!a.wait, t * 1000)
    if (!info) throw new Error(`unknown agent_id ${a.agent_id}`)
    return fmt(info)
  }
}

export const listAgents: ToolDef = {
  name: 'list_agents',
  description: 'List sub-agents in this session with their status.',
  parameters: { type: 'object', properties: {} },
  async run(_a, ctx) {
    const all = ctx.agents.list().filter((x) => x.mode !== 'main')
    return all.length ? all.map((x) => `${x.id}  ${x.name}  ${x.mode}  ${x.status}`).join('\n') : 'no sub-agents'
  }
}
