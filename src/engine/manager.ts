import type { Hooks, Message, ModelAdapter } from './types'
import type { AgentInfo, AgentOps } from './tools/types'
import type { Registry } from './registry/registry'
import { PermissionGate } from './permissions'
import { Semaphore } from './semaphore'
import { runLoop, AbortedError } from './loop'
import { selectTools, MAX_DEPTH } from './tools'
import { buildSubSystem } from './prompt'

interface Entry {
  info: AgentInfo
  controller: AbortController
  done: Promise<void>
  notifications: string[]
  children: Set<string>
}

export interface ManagerOptions {
  adapter: ModelAdapter
  hooks: Hooks
  registry: Registry
  cwd: string
  model: string
  maxConcurrency: number
  maxTurnsSub: number
  autoApprove?: boolean
  reasoning?: 'off' | 'low' | 'medium' | 'high'
}

let counter = 0
const newId = (name: string) => `${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24)}-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** Owns the agent tree: spawning sub-agents, background tracking, notifications and cascading cancellation. */
export class AgentManager implements AgentOps {
  readonly sem: Semaphore
  readonly gate: PermissionGate
  private entries = new Map<string, Entry>()

  constructor(public o: ManagerOptions) {
    this.sem = new Semaphore(o.maxConcurrency)
    this.gate = new PermissionGate(o.hooks, o.autoApprove)
  }

  /** Registers the main agent (one per session turn); returns its controller. */
  registerMain(id: string): AbortController {
    const controller = new AbortController()
    const existing = this.entries.get(id)
    if (existing) {
      existing.controller = controller
      existing.info.status = 'running'
      return controller
    }
    this.entries.set(id, { info: { id, name: 'main', parentId: null, mode: 'main', status: 'running', finalText: '' }, controller, done: Promise.resolve(), notifications: [], children: new Set() })
    return controller
  }

  finishMain(id: string, status: AgentInfo['status'], text: string): void {
    const e = this.entries.get(id)
    if (e) { e.info.status = status; e.info.finalText = text }
  }

  drain(id: string): string[] {
    const e = this.entries.get(id)
    if (!e) return []
    const n = e.notifications
    e.notifications = []
    return n
  }

  hasPendingNotifications(id: string): boolean {
    return (this.entries.get(id)?.notifications.length ?? 0) > 0
  }

  async spawn(opts: { agent?: string; prompt: string; mode: 'sync' | 'background'; parentId: string; depth: number }): Promise<AgentInfo> {
    const parent = this.entries.get(opts.parentId)
    if (!parent) throw new Error(`unknown parent ${opts.parentId}`)
    const def = opts.agent ? this.o.registry.agents.find((a) => a.name === opts.agent) ?? null : null
    if (opts.agent && !def) throw new Error(`unknown agent "${opts.agent}". Available: ${this.o.registry.agents.map((a) => a.name).join(', ') || '(none)'}`)
    const name = def?.name ?? 'general-purpose'
    const id = newId(name)
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    if (parent.controller.signal.aborted) controller.abort()
    else parent.controller.signal.addEventListener('abort', onParentAbort, { once: true })
    // background agents survive their parent's turn ending, but not an explicit stop of the session
    const info: AgentInfo = { id, name, parentId: opts.parentId, mode: opts.mode, status: 'running', finalText: '' }
    const entry: Entry = { info, controller, done: Promise.resolve(), notifications: [], children: new Set() }
    this.entries.set(id, entry)
    parent.children.add(id)

    const canDelegate = opts.depth < MAX_DEPTH
    const tools = selectTools(def?.tools, opts.depth)
    const messages: Message[] = [
      { role: 'system', content: buildSubSystem(this.o.registry, this.o.cwd, def, canDelegate) },
      { role: 'user', content: opts.prompt }
    ]
    this.o.hooks.onEvent({ kind: 'agent_start', agentId: id, parentId: opts.parentId, name, mode: opts.mode, prompt: opts.prompt })

    entry.done = (async () => {
      try {
        info.finalText = await runLoop({
          agentId: id, model: this.o.model, adapter: this.o.adapter, sem: this.sem, hooks: this.o.hooks,
          tools, signal: controller.signal, maxTurns: this.o.maxTurnsSub, reasoning: this.o.reasoning,
          ctx: { cwd: this.o.cwd, depth: opts.depth, hooks: this.o.hooks, gate: this.gate, registry: this.o.registry, agents: this },
          drainNotifications: () => this.drain(id)
        }, messages)
        info.status = 'completed'
      } catch (e: any) {
        info.status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
        info.finalText = info.status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      } finally {
        parent.controller.signal.removeEventListener('abort', onParentAbort)
        this.o.hooks.onEvent({ kind: 'agent_end', agentId: id, status: info.status, finalText: info.finalText })
        if (opts.mode === 'background') {
          const p = this.entries.get(opts.parentId)
          p?.notifications.push(`Background agent ${id} (${name}) ${info.status}. Use read_agent with agent_id "${id}" to get its result.`)
          this.onBackgroundDone?.(opts.parentId)
        }
      }
    })()

    if (opts.mode === 'sync') await entry.done
    return { ...info }
  }

  /** Called when a background agent finishes; lets the engine wake an idle main agent. */
  onBackgroundDone?: (parentId: string) => void

  async read(id: string, wait: boolean, timeoutMs: number): Promise<AgentInfo | null> {
    const e = this.entries.get(id)
    if (!e) return null
    if (wait && e.info.status === 'running') {
      await Promise.race([e.done, new Promise((r) => setTimeout(r, timeoutMs).unref?.())])
    }
    return { ...e.info }
  }

  list(): AgentInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }))
  }

  /** Cancels every running agent (main + all descendants, including background). */
  cancelAll(): void {
    for (const e of this.entries.values()) if (e.info.status === 'running') e.controller.abort()
  }

  running(): number {
    return [...this.entries.values()].filter((e) => e.info.status === 'running' && e.info.mode !== 'main').length
  }
}
