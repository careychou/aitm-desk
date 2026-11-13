import type { Message, ModelAdapter } from './types'
import { COMPACT_TAG, isRealUser } from '../shared/fork'

export interface Turn {
  /** 0-based index among the turns still in the live history. */
  index: number
  messages: Message[]
  user: string
  answer: string
  tools: string[]
}

export interface Cluster { label: string; turns: number[]; reason?: string }

export interface CompactPlan {
  /** Turn indexes kept verbatim (any turns, in original order). */
  keep: number[]
  /** Turn indexes folded into the summary. Turns in neither list are dropped. */
  summarize: number[]
}

/** Plan that keeps the last `n` turns and summarizes everything before them. */
export const keepLastPlan = (turnCount: number, n: number): CompactPlan => {
  const cut = Math.max(0, turnCount - n)
  return { keep: range(cut, turnCount), summarize: range(0, cut) }
}
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)

const END_TAG = '</compacted_history>'
export const COMPACT_ACK = 'Understood. I have the summary of the earlier conversation and will build on it.'

export const estimateTokens = (messages: Message[]) =>
  Math.round(messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4)

/** Existing summary carried by a previous compaction (the leading <compacted_history> message), if any. */
export function priorSummary(history: Message[]): string {
  const m = history[0]
  if (m?.role !== 'user' || !m.content.startsWith(COMPACT_TAG)) return ''
  return m.content.slice(COMPACT_TAG.length).replace(END_TAG, '').trim()
}

/** Splits a history (no system message) into turns; each starts at a real user message. */
export function splitHistoryTurns(history: Message[]): Turn[] {
  const turns: Turn[] = []
  for (const m of history) {
    if (isRealUser(m)) turns.push({ index: turns.length, messages: [m], user: m.content as string, answer: '', tools: [] })
    else if (turns.length) turns[turns.length - 1].messages.push(m)
  }
  for (const t of turns) {
    const answers = t.messages.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content as string)
    t.answer = answers[answers.length - 1] ?? ''
    t.tools = [...new Set(t.messages.flatMap((m) => (m.role === 'assistant' && m.tool_calls ? m.tool_calls.map((c) => c.function.name) : [])))]
  }
  return turns
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
export const digest = (t: Turn, n = 400) => `[${t.index + 1}] USER: ${clip(t.user.replace(/\s+/g, ' '), n)}\nASSISTANT: ${clip(t.answer.replace(/\s+/g, ' '), n)}${t.tools.length ? `\nTOOLS: ${t.tools.join(', ')}` : ''}`

const STOP = new Set('the a an and or of to in on for with is are was were be it this that these those i you we they me my your our can could would should will do does did not no yes so as at by from about what which how why when where who please then than also just use using into its have has had get make let lets one two any all some more most there here them their very now ok okay sure thanks thank like want need'.split(' '))
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9_\-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [])

/** Deterministic fallback: groups turns whose keyword sets overlap (single-link, Jaccard ≥ threshold). */
export function clusterLexical(turns: Turn[], threshold = 0.12): Cluster[] {
  const sets = turns.map((t) => words(`${t.user} ${t.user} ${t.answer}`))
  const parent = turns.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < turns.length; i++) for (let j = i + 1; j < turns.length; j++) {
    const a = sets[i], b = sets[j]
    const inter = [...a].filter((w) => b.has(w)).length
    const uni = a.size + b.size - inter
    if (uni && inter / uni >= threshold) parent[find(j)] = find(i)
  }
  const groups = new Map<number, number[]>()
  turns.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]) })
  return [...groups.values()].map((idx) => {
    const freq = new Map<string, number>()
    for (const i of idx) for (const w of sets[i]) freq.set(w, (freq.get(w) ?? 0) + 1)
    const top = [...freq.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([w]) => w)
    return { label: top.join(' · ') || `Turn ${idx[0] + 1}`, turns: idx.map((i) => turns[i].index) }
  })
}

/** Ensures every turn appears in exactly one cluster (dedupes, drops unknown indexes, adds leftovers as singletons). */
export function normalizeClusters(clusters: Cluster[], turnIdx: number[]): Cluster[] {
  const valid = new Set(turnIdx), seen = new Set<number>()
  const out: Cluster[] = []
  for (const c of clusters) {
    const t = c.turns.filter((i) => valid.has(i) && !seen.has(i))
    t.forEach((i) => seen.add(i))
    if (t.length) out.push({ ...c, turns: t.sort((a, b) => a - b) })
  }
  for (const i of turnIdx) if (!seen.has(i)) out.push({ label: `Turn ${i + 1}`, turns: [i] })
  return out.sort((a, b) => a.turns[0] - b.turns[0])
}

async function complete(adapter: ModelAdapter, model: string, messages: Message[], signal?: AbortSignal): Promise<string> {
  let text = ''
  for await (const d of adapter.stream({ model, messages, reasoning: 'off' }, signal ?? new AbortController().signal)) if (d.type === 'text') text += d.text
  return text
}

/** Asks the model to group turns by topic; falls back to lexical clustering on any failure. */
export async function clusterTurns(adapter: ModelAdapter, model: string, turns: Turn[], signal?: AbortSignal): Promise<{ clusters: Cluster[]; method: 'model' | 'lexical' }> {
  const idx = turns.map((t) => t.index)
  if (turns.length <= 2) return { clusters: normalizeClusters(clusterLexical(turns), idx), method: 'lexical' }
  try {
    const text = await complete(adapter, model, [
      { role: 'system', content: 'You organize chat transcripts. Reply with JSON only, no prose.' },
      { role: 'user', content: `Group these conversation turns into topic clusters. A long chat often pivots between topics and may return to an earlier one; put related turns together even if not adjacent. Every turn number must appear in exactly one cluster. Give each cluster a short label (2-5 words) and a one-line reason.\n\nReturn: {"clusters":[{"label":"...","reason":"...","turns":[1,2]}]}\n\n${turns.map((t) => digest(t)).join('\n\n')}` }
    ], signal)
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const raw: Cluster[] = (json.clusters ?? []).map((c: any) => ({ label: String(c.label ?? '').slice(0, 60), reason: c.reason ? String(c.reason).slice(0, 160) : undefined, turns: (c.turns ?? []).map((n: number) => Number(n) - 1) }))
    if (!raw.length) throw new Error('no clusters')
    return { clusters: normalizeClusters(raw, idx), method: 'model' }
  } catch {
    return { clusters: normalizeClusters(clusterLexical(turns), idx), method: 'lexical' }
  }
}

function transcript(t: Turn): string {
  const parts = [`### Turn ${t.index + 1}\nUSER: ${t.user}`]
  for (const m of t.messages.slice(1)) {
    if (m.role === 'assistant') {
      if (m.content) parts.push(`ASSISTANT: ${clip(m.content, 6000)}`)
      for (const c of m.tool_calls ?? []) parts.push(`TOOL CALL ${c.function.name}: ${clip(c.function.arguments, 600)}`)
    } else if (m.role === 'tool') parts.push(`TOOL RESULT: ${clip(m.content, 1500)}`)
    else if (m.role === 'user') parts.push(`NOTIFICATION: ${clip(m.content, 800)}`)
  }
  return parts.join('\n')
}

export async function summarizeTurns(adapter: ModelAdapter, model: string, turns: Turn[], prior: string, signal?: AbortSignal): Promise<string> {
  if (!turns.length) return prior
  const text = await complete(adapter, model, [
    { role: 'system', content: 'You compress conversation history into working memory for an AI agent that will continue the conversation.' },
    { role: 'user', content: `${prior ? `Existing summary of even earlier history (merge it in):\n${prior}\n\n` : ''}Summarize the turns below into a dense Markdown memory the agent can rely on instead of the raw turns. Keep: the user's goals and preferences, key facts and numbers, decisions and their reasons, files/paths/commands that matter, results of tool runs, and open questions or next steps. Group by topic. Omit pleasantries and dead ends unless they explain a decision. Be concise but lose nothing important.\n\n${turns.map(transcript).join('\n\n')}` }
  ], signal)
  if (!text.trim()) throw new Error('model returned an empty summary')
  return text.trim()
}

/** Builds the compacted history: [summary, ack, ...kept turns verbatim in original order]. Pure. */
export function applyCompaction(history: Message[], summary: string, keep: number[]): Message[] {
  const k = new Set(keep)
  const recent = splitHistoryTurns(history).filter((t) => k.has(t.index)).flatMap((t) => t.messages)
  const head: Message[] = summary.trim()
    ? [{ role: 'user', content: `${COMPACT_TAG}\nSummary of the earlier conversation (older turns were compacted):\n\n${summary.trim()}\n${END_TAG}` }, { role: 'assistant', content: COMPACT_ACK }]
    : []
  return [...head, ...recent]
}

/** Splits turns per plan into kept / summarized / dropped (keep wins over summarize). */
export function planTurns(turns: Turn[], plan: CompactPlan) {
  const keep = new Set(plan.keep), sum = new Set(plan.summarize)
  return {
    kept: turns.filter((t) => keep.has(t.index)),
    summarized: turns.filter((t) => !keep.has(t.index) && sum.has(t.index)),
    dropped: turns.filter((t) => !keep.has(t.index) && !sum.has(t.index))
  }
}
