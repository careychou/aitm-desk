import crypto from 'node:crypto'
import type { ChatRequest, ContentPart, Delta, Message, ModelAdapter, ToolSchema } from '../types'
import { parseSSE } from './sse'
import { fitRequest, type RequestBudget } from '../content'
import { OpenAIAdapter } from './openai'
import { VertexAuth } from './vertex-auth'
import { parseVertexModels, type VertexModel } from '../../shared/providers'

export interface VertexConfig {
  project: string
  /** Default region for models without their own (`global` for the Model Bank MaaS models). */
  location?: string
  /** Service-account (or ADC) JSON path; empty = $GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC. */
  credentialsPath?: string
  /** Raw model lines (`id [@location] [describe]`), see parseVertexModels. */
  models: string[]
  /** Model that transcribes images for text-only (`describe`) models. */
  visionModel?: string
  /** Claude prompt-cache TTL; `off` disables cache breakpoints. */
  cacheTtl?: '5m' | '1h' | 'off'
  budget?: () => RequestBudget
  /** Tests only: replaces https://{loc-}aiplatform.googleapis.com. */
  endpoint?: string
}

export const DEFAULT_VISION_MODEL = 'google/gemini-3.8-flash'
const ANTHROPIC_VERSION = 'vertex-2023-10-16'
const STOP: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'stop' }

const DESCRIBE_PROMPT =
  'You are the eyes for a text-only AI model that cannot see this image. Produce a complete, faithful text rendition of it: ' +
  '(1) transcribe ALL visible text verbatim, preserving structure (headings, tables as markdown, lists, labels, numbers, units); ' +
  '(2) describe layout, charts (axes, series, values, trends), diagrams, UI elements, colors and any other visual content. ' +
  'Be exhaustive and precise; do not add commentary or speculation.'

const textOf = (c: string | ContentPart[] | null | undefined) =>
  c == null ? '' : typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('')

type Block = Record<string, any>

function toBlocks(c: string | ContentPart[] | null | undefined): Block[] {
  if (c == null || typeof c === 'string') return [{ type: 'text', text: c ?? '' }]
  const out: Block[] = []
  for (const p of c) {
    if (p.type === 'text') { if (p.text) out.push({ type: 'text', text: p.text }) }
    else {
      const url = p.image_url?.url ?? ''
      const m = /^data:([^;,]*);base64,(.*)$/s.exec(url)
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] } })
      else if (url) out.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return out.length ? out : [{ type: 'text', text: '' }]
}

/** OpenAI chat request → Anthropic Messages body (system, tools, tool_use/tool_result, images, thinking). */
export function toAnthropic(msgs: Message[], req: Pick<ChatRequest, 'tools' | 'maxTokens' | 'reasoning'>, cacheTtl: '5m' | '1h' | 'off' = '5m'): Record<string, any> {
  const system: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const m of msgs) {
    if (m.role === 'system') { if (m.content) system.push(m.content) }
    else if (m.role === 'assistant') {
      const blocks: Block[] = []
      const t = textOf(m.content)
      if (t) blocks.push({ type: 'text', text: t })
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { /* keep {} */ }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
      }
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '' }])
    } else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: toBlocks(m.content) }])
    else push('user', toBlocks(m.content))
  }
  const body: Record<string, any> = {
    anthropic_version: ANTHROPIC_VERSION,
    messages: out.length ? out : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    max_tokens: req.maxTokens ?? 16000
  }
  if (system.length) body.system = system.join('\n\n')
  // Claude 5 on Vertex only accepts adaptive thinking, and rejects temperature/top_p
  if (req.reasoning && req.reasoning !== 'off') {
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort: req.reasoning }
  }
  if (req.tools?.length) body.tools = req.tools.map((t: ToolSchema) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }))
  if (cacheTtl !== 'off') applyPromptCache(body, cacheTtl)
  return body
}

/**
 * Anthropic cache_control breakpoints (max 4). Prefix order is tools → system → messages, so each
 * caches everything before it: last tool, system prompt, last block of the final message (rolling
 * history), last block of the previous user turn (safety net for the 20-block lookback).
 */
export function applyPromptCache(body: Record<string, any>, ttl: '5m' | '1h'): void {
  const mark = () => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' })
  if (body.tools?.length) body.tools[body.tools.length - 1].cache_control = mark()
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system, cache_control: mark() }]
  const msgs: Array<{ role: string; content: Block[] }> = body.messages
  const targets = msgs.length ? [msgs[msgs.length - 1]] : []
  for (let i = msgs.length - 2; i >= 0; i--) if (msgs[i].role === 'user') { targets.push(msgs[i]); break }
  for (const m of targets) {
    const b = [...m.content].reverse().find((x) => !(x.type === 'text' && !x.text))
    if (b) b.cache_control = mark()
  }
}

/** Anthropic SSE event stream → engine deltas. */
export async function* anthropicDeltas(events: AsyncIterable<string>): AsyncGenerator<Delta> {
  const tools = new Map<number, number>()
  let usage = { input: 0, read: 0, write: 0, output: 0 }
  let stop = ''
  for await (const data of events) {
    let e: any
    try { e = JSON.parse(data) } catch { continue }
    switch (e.type) {
      case 'error': throw new Error(`upstream: ${e.error?.message ?? JSON.stringify(e.error)}`)
      case 'message_start': {
        const u = e.message?.usage ?? {}
        usage = { input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
        break
      }
      case 'content_block_start': {
        const b = e.content_block ?? {}
        if (b.type === 'tool_use') {
          const i = tools.size
          tools.set(e.index, i)
          yield { type: 'tool_call', index: i, id: b.id, name: b.name }
        } else if (b.type === 'text' && b.text) yield { type: 'text', text: b.text }
        else if (b.type === 'thinking' && b.thinking) yield { type: 'reasoning', text: b.thinking }
        break
      }
      case 'content_block_delta': {
        const d = e.delta ?? {}
        if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text }
        else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking }
        else if (d.type === 'input_json_delta' && d.partial_json && tools.has(e.index)) yield { type: 'tool_call', index: tools.get(e.index)!, args: d.partial_json }
        break
      }
      case 'content_block_stop':
        if (tools.has(e.index)) yield { type: 'tool_call', index: tools.get(e.index)!, args: '' }
        break
      case 'message_delta': {
        const u = e.usage ?? {}
        if (u.output_tokens != null) usage.output = u.output_tokens
        if (u.input_tokens != null) usage.input = u.input_tokens
        if (u.cache_read_input_tokens != null) usage.read = u.cache_read_input_tokens
        if (u.cache_creation_input_tokens != null) usage.write = u.cache_creation_input_tokens
        if (e.delta?.stop_reason) stop = e.delta.stop_reason
        break
      }
      case 'message_stop':
        // Anthropic input_tokens excludes cached tokens; the engine's prompt count includes them
        yield { type: 'usage', prompt: usage.input + usage.read + usage.write, completion: usage.output, cached: usage.read, cacheWrite: usage.write }
        yield { type: 'finish', reason: STOP[stop] ?? 'stop' }
        return
    }
  }
}

const VERTEX_EFFORT: Record<string, string> = { off: '', low: 'low', medium: 'medium', high: 'high' }

/** Native Google Vertex AI provider: Claude via Anthropic streamRawPredict, everything else via the OpenAI-compatible endpoint. */
export class VertexAdapter implements ModelAdapter {
  readonly auth: VertexAuth
  private oai = new Map<string, OpenAIAdapter>()
  private described = new Map<string, string>()

  constructor(private cfg: VertexConfig) {
    this.auth = new VertexAuth(cfg.credentialsPath ?? '')
  }

  private get models(): VertexModel[] { return parseVertexModels(this.cfg.models, this.cfg.location || 'global') }
  private model(id: string): VertexModel { return this.models.find((m) => m.id === id) ?? { id, location: this.cfg.location || 'global', vision: true } }

  private host(loc: string): string {
    if (this.cfg.endpoint) return this.cfg.endpoint.replace(/\/$/, '')
    return loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`
  }
  private base(loc: string): string {
    if (!this.cfg.project.trim()) throw new Error('GCP project is not set')
    return `${this.host(loc)}/v1/projects/${encodeURIComponent(this.cfg.project.trim())}/locations/${encodeURIComponent(loc)}`
  }

  async listModels(): Promise<string[]> {
    if (!this.cfg.project.trim()) throw new Error('GCP project is not set')
    return this.models.map((m) => m.id)
  }

  /** Settings → Test: mint a token, then a 1-token request to the first model to prove project access. */
  async verify(): Promise<string[]> {
    const ms = await this.listModels()
    if (!ms.length) throw new Error('no models configured')
    await this.auth.token(true)
    const probe = ms.find((m) => !m.startsWith('anthropic/')) ?? ms[0]
    for await (const _ of this.stream({ model: probe, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }, AbortSignal.timeout(30_000))) { /* drain */ }
    return ms
  }

  /** POST with a Bearer token: refresh once on 401, back off on 429/503. */
  private async post(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const tok = await this.auth.token(attempt === 2)
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body), signal })
      if (r.ok || attempt >= 4 || ![401, 429, 503].includes(r.status) || (r.status === 401 && attempt >= 2)) return r
      await r.body?.cancel().catch(() => {})
      await new Promise((res) => setTimeout(res, r.status === 401 ? 0 : 600 * attempt))
    }
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const m = this.model(req.model)
    let messages = this.cfg.budget ? fitRequest(req.messages, this.cfg.budget()) : req.messages
    if (m.vision === 'describe') messages = await this.describeImages(messages, signal)
    if (m.id.startsWith('anthropic/')) yield* this.claude(m, { ...req, messages }, signal)
    else yield* this.openapi(m, { ...req, messages }, signal)
  }

  private async *claude(m: VertexModel, req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const body = { ...toAnthropic(req.messages, req, this.cfg.cacheTtl ?? '5m'), stream: true }
    const slug = m.id.slice('anthropic/'.length)
    const res = await this.post(`${this.base(m.location)}/publishers/anthropic/models/${encodeURIComponent(slug)}:streamRawPredict`, body, signal)
    if (!res.ok || !res.body) throw await httpError(res)
    yield* anthropicDeltas(parseSSE(res.body as unknown as AsyncIterable<Uint8Array>))
  }

  private openapi(m: VertexModel, req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    let a = this.oai.get(m.location)
    if (!a) {
      a = new OpenAIAdapter({
        baseUrl: `${this.base(m.location)}/endpoints/openapi`,
        apiKey: '',
        fetch: (url, init) => this.post(url, JSON.parse(String(init.body)), init.signal as AbortSignal),
        shape: (body) => {
          // Vertex rejects include_reasoning; Gemini only streams thoughts via thinking_config (not alongside reasoning_effort)
          const want = body.include_reasoning
          delete body.include_reasoning
          if (typeof body.reasoning_effort === 'string') body.reasoning_effort = VERTEX_EFFORT[body.reasoning_effort] || undefined
          if (want && String(body.model).startsWith('google/gemini')) {
            delete body.reasoning_effort
            body.extra_body = { google: { thinking_config: { include_thoughts: true } } }
          }
        }
      })
      this.oai.set(m.location, a)
    }
    return a.stream(req, signal)
  }

  /** Swaps image parts for text transcriptions by the vision model (cached per image). */
  private async describeImages(msgs: Message[], signal: AbortSignal): Promise<Message[]> {
    const vm = this.cfg.visionModel?.trim() || DEFAULT_VISION_MODEL
    if (this.model(vm).vision === 'describe') throw new Error(`vision model ${vm} is itself text-only`)
    return Promise.all(msgs.map(async (msg) => {
      if (msg.role !== 'user' || typeof msg.content === 'string') return msg
      if (!msg.content.some((p) => p.type === 'image_url')) return msg
      const content = await Promise.all(msg.content.map(async (p): Promise<ContentPart> => (p.type === 'image_url' ? { type: 'text', text: await this.describe(p.image_url.url, vm, signal) } : p)))
      return { ...msg, content }
    }))
  }

  private async describe(url: string, vm: string, signal: AbortSignal): Promise<string> {
    const key = crypto.createHash('sha256').update(url).digest('hex')
    const hit = this.described.get(key)
    if (hit) return hit
    let text = ''
    try {
      for await (const d of this.stream({ model: vm, maxTokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: DESCRIBE_PROMPT }, { type: 'image_url', image_url: { url } }] }] }, signal)) if (d.type === 'text') text += d.text
    } catch (e) {
      if (signal.aborted) throw e
    }
    if (!text.trim()) return '[An image was attached but could not be transcribed.]'
    const out = `[Attached image — transcribed for you by ${vm}]\n${text.trim()}\n[End of image]`
    if (this.described.size > 256) this.described.clear()
    this.described.set(key, out)
    return out
  }
}

async function httpError(res: Response): Promise<Error> {
  const t = await res.text().catch(() => '')
  let msg = t
  try { const j = JSON.parse(t); msg = j.error?.message ?? j[0]?.error?.message ?? t } catch { /* raw */ }
  return Object.assign(new Error(`HTTP ${res.status}: ${msg.slice(0, 500)}`), { status: res.status })
}
