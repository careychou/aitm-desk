import type { Hooks, Message, ModelAdapter } from './types'
import { loadRegistry, type Registry } from './registry/registry'
import { AgentManager } from './manager'
import { runLoop, AbortedError } from './loop'
import { selectTools } from './tools'
import { buildMainSystem } from './prompt'

export interface SessionOptions {
  adapter: ModelAdapter
  hooks: Hooks
  cwd: string
  model: string
  home?: string
  maxConcurrency?: number
  maxTurnsMain?: number
  maxTurnsSub?: number
  autoApprove?: boolean
  /** Prior conversation (without system message) to resume. */
  history?: Message[]
}

export const MAIN_ID = 'main'

/** One chat session: a persistent main-agent conversation plus its sub-agent tree. */
export class Session {
  readonly registry: Registry
  readonly manager: AgentManager
  readonly messages: Message[]
  private busy = false

  constructor(private o: SessionOptions) {
    this.registry = loadRegistry({ cwd: o.cwd, home: o.home })
    this.manager = new AgentManager({
      adapter: o.adapter, hooks: o.hooks, registry: this.registry, cwd: o.cwd, model: o.model,
      maxConcurrency: o.maxConcurrency ?? 4, maxTurnsSub: o.maxTurnsSub ?? 30, autoApprove: o.autoApprove
    })
    this.messages = [{ role: 'system', content: buildMainSystem(this.registry, o.cwd) }, ...(o.history ?? [])]
    this.manager.onBackgroundDone = (parentId) => {
      if (parentId === MAIN_ID && !this.busy) this.onIdleNotification?.()
    }
  }

  /** Fired when a background sub-agent finishes while the main agent is idle. */
  onIdleNotification?: () => void

  get isBusy() { return this.busy }

  setModel(model: string) { this.o.model = model; this.manager.o.model = model }

  /** Sends a user prompt (or, with no prompt, just delivers pending notifications) and runs the main loop. */
  async send(prompt?: string): Promise<{ status: 'completed' | 'failed' | 'cancelled'; text: string }> {
    if (this.busy) throw new Error('session is busy')
    this.busy = true
    const controller = this.manager.registerMain(MAIN_ID)
    if (prompt) this.messages.push({ role: 'user', content: prompt })
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let text = ''
    try {
      text = await runLoop({
        agentId: MAIN_ID, model: this.o.model, adapter: this.o.adapter, sem: this.manager.sem, hooks: this.o.hooks,
        tools: selectTools(undefined, 0), signal: controller.signal, maxTurns: this.o.maxTurnsMain ?? 50,
        ctx: { cwd: this.o.cwd, depth: 0, hooks: this.o.hooks, gate: this.manager.gate, registry: this.registry, agents: this.manager },
        drainNotifications: () => this.manager.drain(MAIN_ID)
      }, this.messages)
    } catch (e: any) {
      status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
      text = status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      if (status === 'failed') this.o.hooks.onEvent({ kind: 'error', agentId: MAIN_ID, message: text })
      this.repairHistory()
    } finally {
      this.busy = false
      this.manager.finishMain(MAIN_ID, status, text)
      this.o.hooks.onEvent({ kind: 'agent_end', agentId: MAIN_ID, status, finalText: text })
    }
    if (this.manager.hasPendingNotifications(MAIN_ID)) queueMicrotask(() => this.onIdleNotification?.())
    return { status, text }
  }

  /** After an interruption, make sure every assistant tool_call has a matching tool result. */
  private repairHistory() {
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant') as Extract<Message, { role: 'assistant' }> | undefined
    if (!last?.tool_calls) return
    const have = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id))
    for (const c of last.tool_calls) if (!have.has(c.id)) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: cancelled' })
  }

  stop() { this.manager.cancelAll() }
}
