import type { Hooks, Message, ModelAdapter } from './types'
import { buildUserContent, type Attachment } from './content'
import { loadRegistry, type Registry } from './registry/registry'
import { AgentManager } from './manager'
import { runLoop, AbortedError } from './loop'
import { selectTools } from './tools'
import { buildMainSystem } from './prompt'
import { applyCompaction, clusterTurns, estimateTokens, planTurns, priorSummary, splitHistoryTurns, summarizeTurns, type CompactPlan } from './compact'

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
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  /** Paths of exported sessions to load as prior memory. */
  memories?: string[]
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
  private queue: Array<{ qid?: string; content: Message['content'] }> = []

  constructor(private o: SessionOptions) {
    this.registry = loadRegistry({ cwd: o.cwd, home: o.home })
    this.manager = new AgentManager({
      adapter: o.adapter, hooks: o.hooks, registry: this.registry, cwd: o.cwd, model: o.model,
      maxConcurrency: o.maxConcurrency ?? 4, maxTurnsSub: o.maxTurnsSub ?? 30, autoApprove: o.autoApprove, reasoning: o.reasoning ?? 'medium'
    })
    this.messages = [{ role: 'system', content: buildMainSystem(this.registry, o.cwd, o.memories) }, ...(o.history ?? [])]
    this.manager.onBackgroundDone = (parentId) => {
      if (parentId === MAIN_ID && !this.busy) this.onIdleNotification?.()
    }
  }

  /** Fired when a background sub-agent finishes while the main agent is idle. */
  onIdleNotification?: () => void

  get isBusy() { return this.busy }

  setModel(model: string) { this.o.model = model; this.manager.o.model = model }
  setReasoning(r: 'off' | 'low' | 'medium' | 'high') { this.o.reasoning = r; this.manager.o.reasoning = r }
  /** Replaces attached memories; takes effect on the next model call. */
  setMemories(paths: string[]) { this.o.memories = paths; this.messages[0] = { role: 'system', content: buildMainSystem(this.registry, this.o.cwd, paths) } }

  /** Prompts waiting to be added to the conversation. */
  get queued() { return this.queue.map((q) => q.qid) }

  /**
   * Sends a user prompt (or, with no prompt, just delivers pending notifications) and runs the main loop.
   * While a run is in progress the prompt is queued instead: it joins the same conversation before the
   * next model call (after the current tool results), or starts the next run if the agent has just answered.
   */
  async send(prompt?: string, attachments: Attachment[] = [], qid?: string): Promise<{ status: 'completed' | 'failed' | 'cancelled' | 'queued'; text: string }> {
    if (prompt || attachments.length) this.queue.push({ qid, content: buildUserContent(prompt ?? '', attachments) as Message['content'] })
    if (this.busy) return { status: 'queued', text: '' }
    this.busy = true
    const controller = this.manager.registerMain(MAIN_ID)
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let text = ''
    try {
      do {
        text = await runLoop({
          agentId: MAIN_ID, model: this.o.model, adapter: this.o.adapter, sem: this.manager.sem, hooks: this.o.hooks,
          tools: selectTools(undefined, 0), signal: controller.signal, maxTurns: this.o.maxTurnsMain ?? 50, reasoning: this.o.reasoning ?? 'medium',
          ctx: { cwd: this.o.cwd, depth: 0, hooks: this.o.hooks, gate: this.manager.gate, registry: this.registry, agents: this.manager },
          drainNotifications: () => this.manager.drain(MAIN_ID),
          drainInput: () => this.drainQueue()
        }, this.messages)
      } while (this.queue.length)
    } catch (e: any) {
      status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
      text = status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      if (status === 'failed') this.o.hooks.onEvent({ kind: 'error', agentId: MAIN_ID, message: text })
      this.repairHistory()
      const dropped = this.queue.splice(0).flatMap((q) => (q.qid ? [q.qid] : []))
      if (dropped.length) this.o.hooks.onEvent({ kind: 'queue_cleared', agentId: MAIN_ID, qids: dropped })
    } finally {
      this.busy = false
      this.manager.finishMain(MAIN_ID, status, text)
      this.o.hooks.onEvent({ kind: 'agent_end', agentId: MAIN_ID, status, finalText: text })
    }
    if (this.manager.hasPendingNotifications(MAIN_ID)) queueMicrotask(() => this.onIdleNotification?.())
    return { status, text }
  }

  /** Removes a queued prompt before it reaches the model. Returns false if it was already sent. */
  unqueue(qid: string) {
    const i = this.queue.findIndex((q) => q.qid === qid)
    if (i >= 0) this.queue.splice(i, 1)
    return i >= 0
  }

  private drainQueue(): Message[] {
    return this.queue.splice(0).map((q) => {
      if (q.qid) this.o.hooks.onEvent({ kind: 'user_input', agentId: MAIN_ID, qid: q.qid })
      return { role: 'user', content: q.content } as Message
    })
  }

  /** After an interruption, make sure every assistant tool_call has a matching tool result. */
  private repairHistory() {
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant') as Extract<Message, { role: 'assistant' }> | undefined
    if (!last?.tool_calls) return
    const have = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id))
    for (const c of last.tool_calls) if (!have.has(c.id)) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: cancelled' })
  }

  stop() { this.manager.cancelAll() }

  get history(): Message[] { return this.messages.slice(1) }
  get tokenEstimate() { return estimateTokens(this.messages) }

  /** Turn digests plus topic clusters for the compaction picker. */
  async analyzeTurns(signal?: AbortSignal) {
    const turns = splitHistoryTurns(this.history)
    const { clusters, method } = await clusterTurns(this.o.adapter, this.o.model, turns, signal)
    return {
      turns: turns.map((t) => ({ index: t.index, user: t.user, answer: t.answer, tools: t.tools, tokens: estimateTokens(t.messages) })),
      clusters, method, hasPriorSummary: !!priorSummary(this.history), tokens: this.tokenEstimate
    }
  }

  /** Keeps `plan.keep` turns verbatim, folds `plan.summarize` into the summary, drops the rest. */
  async compact(plan: CompactPlan, signal?: AbortSignal) {
    if (this.busy) throw new Error('session is busy')
    this.busy = true
    try {
      const before = this.tokenEstimate
      const turns = splitHistoryTurns(this.history)
      const { kept, summarized, dropped } = planTurns(turns, plan)
      const keptIdx = kept.map((t) => t.index)
      if (!summarized.length && !dropped.length) return { before, after: before, summarized: 0, dropped: 0, summary: '', kept: keptIdx, compacted: [] as number[] }
      const summary = await summarizeTurns(this.o.adapter, this.o.model, summarized, priorSummary(this.history), signal)
      const next = applyCompaction(this.history, summary, keptIdx)
      this.messages.splice(1, this.messages.length - 1, ...next)
      return { before, after: this.tokenEstimate, summarized: summarized.length, dropped: dropped.length, summary, kept: keptIdx, compacted: [...summarized, ...dropped].map((t) => t.index) }
    } finally { this.busy = false }
  }
}
