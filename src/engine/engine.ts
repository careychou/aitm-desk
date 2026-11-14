import type { Hooks, Message, ModelAdapter } from './types'
import { buildUserContent, type Attachment } from './content'
import { loadRegistry, type Registry } from './registry/registry'
import { AgentManager } from './manager'
import { runLoop, AbortedError } from './loop'
import { selectTools } from './tools'
import { ShellManager } from './tools/shell'
import { closeSessionDb } from './tools/sql'
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
  /** Per-chat folder for scratch state (sql tool database). */
  stateDir?: string
  /** Prior conversation (without system message) to resume. */
  history?: Message[]
  /** Model for summarizing/clustering during compaction; read on each use. Empty = the chat's model. */
  compactModel?: () => string
}

/** agentId used for usage events from compaction calls. */
export const COMPACT_ID = 'compact'

export const MAIN_ID = 'main'

/** One chat session: a persistent main-agent conversation plus its sub-agent tree. */
export class Session {
  readonly registry: Registry
  readonly manager: AgentManager
  readonly messages: Message[]
  readonly shells = new ShellManager()
  private busy = false
  private queue: Array<{ qid?: string; content: Message['content'] }> = []

  constructor(private o: SessionOptions) {
    this.registry = loadRegistry({ cwd: o.cwd, home: o.home })
    this.manager = new AgentManager({
      adapter: o.adapter, hooks: o.hooks, registry: this.registry, cwd: o.cwd, model: o.model,
      maxConcurrency: o.maxConcurrency ?? 4, maxTurnsSub: o.maxTurnsSub ?? 30, autoApprove: o.autoApprove, reasoning: o.reasoning ?? 'medium',
      shells: this.shells, stateDir: o.stateDir
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
  /** interactive asks before shell/write/url tools; autopilot approves them automatically. */
  setMode(mode: 'interactive' | 'autopilot') { this.manager.gate.setAutoApprove(mode === 'autopilot') }
  /** Stops background shells and closes the scratch database. */
  dispose() { this.shells.dispose(); if (this.o.stateDir) closeSessionDb(this.o.stateDir) }
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
          ctx: { cwd: this.o.cwd, depth: 0, hooks: this.o.hooks, gate: this.manager.gate, registry: this.registry, agents: this.manager, shells: this.shells, stateDir: this.o.stateDir },
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

  /** The model compaction uses (Settings → Memory compaction), or the chat's own model. */
  get compactModel(): string { return this.o.compactModel?.().trim() || this.o.model }

  /** The chat adapter, reporting usage of compaction calls under COMPACT_ID. */
  private compactAdapter(model: string): ModelAdapter {
    const inner = this.o.adapter, hooks = this.o.hooks
    return {
      async *stream(req, signal) {
        for await (const d of inner.stream(req, signal)) {
          if (d.type === 'usage') hooks.onEvent({ kind: 'usage', agentId: COMPACT_ID, model, prompt: d.prompt, completion: d.completion, cached: d.cached, cacheWrite: d.cacheWrite })
          yield d
        }
      }
    }
  }

  /** Runs `fn` with the compaction model, falling back to the chat model if that fails (e.g. not offered by the provider). */
  private async withCompactModel<T>(fn: (adapter: ModelAdapter, model: string) => Promise<T>): Promise<T & { model: string }> {
    const first = this.compactModel
    try { return { ...(await fn(this.compactAdapter(first), first)), model: first } } catch (e) {
      if (first === this.o.model) throw e
      return { ...(await fn(this.compactAdapter(this.o.model), this.o.model)), model: this.o.model }
    }
  }

  /** Turn digests plus topic clusters for the compaction picker. */
  async analyzeTurns(signal?: AbortSignal) {
    const turns = splitHistoryTurns(this.history)
    let model = this.compactModel
    let { clusters, method } = await clusterTurns(this.compactAdapter(model), model, turns, signal)
    // clusterTurns swallows model errors (keyword fallback); retry once with the chat's model
    if (method === 'lexical' && model !== this.o.model && turns.length > 2 && !signal?.aborted) {
      const r = await clusterTurns(this.compactAdapter(this.o.model), this.o.model, turns, signal)
      if (r.method !== 'lexical') { ({ clusters, method } = r); model = this.o.model }
    }
    return {
      turns: turns.map((t) => ({ index: t.index, user: t.user, answer: t.answer, tools: t.tools, tokens: estimateTokens(t.messages) })),
      clusters, method, model, hasPriorSummary: !!priorSummary(this.history), tokens: this.tokenEstimate
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
      if (!summarized.length && !dropped.length) return { before, after: before, summarized: 0, dropped: 0, summary: '', model: '', kept: keptIdx, compacted: [] as number[] }
      const { text: summary, model } = await this.withCompactModel(async (a, m) => ({ text: await summarizeTurns(a, m, summarized, priorSummary(this.history), signal) }))
      const next = applyCompaction(this.history, summary, keptIdx)
      this.messages.splice(1, this.messages.length - 1, ...next)
      return { before, after: this.tokenEstimate, summarized: summarized.length, dropped: dropped.length, summary, model, kept: keptIdx, compacted: [...summarized, ...dropped].map((t) => t.index) }
    } finally { this.busy = false }
  }
}
