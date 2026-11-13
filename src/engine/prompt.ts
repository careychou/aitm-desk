import os from 'node:os'
import type { Registry, AgentDef } from './registry/registry'

const BASE = `You are AITM Desk, an interactive AI agent running on the user's Mac. You help with analysis, data, research and software tasks.

# How to work
- Use tools to act; don't just describe what you would do. To run code: write it with write_file, then run it with shell (e.g. \`python3 script.py\`).
- Before acting on a task that a listed skill covers, call the skill tool to load its full instructions, then follow them.
- For complex, separable work, delegate to sub-agents with the task tool. Emit multiple task calls in ONE response to run them in parallel. Use mode "background" for long work you can check later with read_agent.
- Make independent tool calls in parallel (several calls in one response).
- Never print secret values. Be concise in final answers.`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function environment(cwd: string): string {
  return `# Environment\n- Working folder: ${cwd}\n- OS: macOS ${os.release()}\n- Date: ${new Date().toISOString()}`
}

function skillsSection(reg: Registry): string {
  if (!reg.skills.length) return ''
  return `# Available skills (load with the skill tool)\n` + reg.skills.map((s) => `- ${s.name}: ${clip(s.description, 250)}`).join('\n')
}

function agentsSection(reg: Registry): string {
  if (!reg.agents.length) return ''
  return `# Available agents (pass as "agent" to the task tool)\n` + reg.agents.map((a) => `- ${a.name}: ${clip(a.description, 200)}`).join('\n')
}

export function buildMainSystem(reg: Registry, cwd: string): string {
  return [BASE, environment(cwd), reg.instructions && `# User and project instructions\n${reg.instructions}`, skillsSection(reg), agentsSection(reg)].filter(Boolean).join('\n\n')
}

export function buildSubSystem(reg: Registry, cwd: string, agent: AgentDef | null, canDelegate: boolean): string {
  const role = agent
    ? `You are the "${agent.name}" sub-agent.\n\n${agent.body.trim()}`
    : `You are a general-purpose sub-agent. Complete the task you are given autonomously using your tools.`
  const rules = `# Sub-agent rules\n- You start with no prior conversation; the task prompt is all the context you get.\n- Work autonomously; your FINAL message is returned to the caller verbatim, so make it a complete, self-contained answer.${canDelegate ? '' : '\n- You cannot launch further sub-agents.'}`
  return [role, rules, environment(cwd), reg.instructions && `# User and project instructions\n${reg.instructions}`, skillsSection(reg), canDelegate ? agentsSection(reg) : ''].filter(Boolean).join('\n\n')
}
