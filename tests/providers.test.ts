import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { OpenAIAdapter } from '../src/engine/adapter/openai'
import { ProviderRouter } from '../src/engine/adapter/router'
import { bareModel, migrateProviders, providerId, splitModel, type ProviderEntry } from '../src/shared/providers'
import type { Delta } from '../src/engine/types'

interface Hit { url: string; headers: http.IncomingHttpHeaders; body: any }

/** Fake provider: records requests and streams one text delta, or answers per `reply`. */
function fake(reply?: (h: Hit) => { status: number; body: string } | null): Promise<{ host: string; hits: Hit[]; close(): void }> {
  const hits: Hit[] = []
  return new Promise((res) => {
    const s = http.createServer((req, rs) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        const h = { url: req.url ?? '', headers: req.headers, body: b ? JSON.parse(b) : null }
        hits.push(h)
        const r = reply?.(h)
        if (r) { rs.writeHead(r.status, { 'content-type': 'application/json' }); rs.end(r.body); return }
        if (req.method === 'GET') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] })); return }
        rs.writeHead(200, { 'content-type': 'text/event-stream' })
        rs.write('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n')
        rs.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
        rs.end('data: [DONE]\n\n')
      })
    }).listen(0, '127.0.0.1', () => res({ host: `http://127.0.0.1:${(s.address() as any).port}`, hits, close: () => s.close() }))
  })
}

async function text(it: AsyncIterable<Delta>) {
  let t = ''
  for await (const d of it) if (d.type === 'text') t += d.text
  return t
}
const req = (model: string, effort?: 'low' | 'medium' | 'high') => ({ model, messages: [{ role: 'user' as const, content: 'hi' }], reasoning: effort })

describe('Azure OpenAI adapter', () => {
  it('calls the deployment URL with api-key, api-version and max_completion_tokens', async () => {
    const f = await fake()
    const a = new OpenAIAdapter({ kind: 'azure', baseUrl: `${f.host}/openai/v1/`, apiKey: 'az', apiVersion: '2024-10-21', deployments: ['gpt-5'] })
    expect(await text(a.stream({ ...req('gpt-5', 'high'), maxTokens: 100 } as any, new AbortController().signal))).toBe('ok')
    const h = f.hits[0]
    expect(h.url).toBe('/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21')
    expect(h.headers['api-key']).toBe('az')
    expect(h.headers.authorization).toBeUndefined()
    expect(h.body.reasoning_effort).toBe('high')
    expect(h.body.include_reasoning).toBeUndefined()
    expect(h.body.max_tokens).toBeUndefined()
    f.close()
  })

  it('retries once without reasoning_effort when the deployment rejects it', async () => {
    const f = await fake((h) => (h.body?.reasoning_effort ? { status: 400, body: '{"error":{"code":"unsupported_parameter","message":"reasoning_effort is not supported"}}' } : null))
    const a = new OpenAIAdapter({ kind: 'azure', baseUrl: f.host, apiKey: 'az', deployments: ['gpt-4o'] })
    expect(await text(a.stream(req('gpt-4o', 'medium'), new AbortController().signal))).toBe('ok')
    expect(f.hits.length).toBe(2)
    expect(f.hits[1].body.reasoning_effort).toBeUndefined()
    f.close()
  })

  it('lists the configured deployments as models without a network call', async () => {
    const a = new OpenAIAdapter({ kind: 'azure', baseUrl: 'https://x.openai.azure.com', apiKey: 'k', deployments: [' gpt-5 ', '', 'mini'] })
    expect(await a.listModels()).toEqual(['gpt-5', 'mini'])
  })
})

describe('ProviderRouter', () => {
  it('keeps primary models bare, prefixes the others, and routes by prefix', async () => {
    const p1 = await fake(), p2 = await fake()
    const providers: ProviderEntry[] = [
      { id: 'default', name: 'Custom', kind: 'openai', baseUrl: `${p1.host}/v1`, apiKey: 'a' },
      { id: 'lab', name: 'Lab', kind: 'openai', baseUrl: `${p2.host}/v1`, apiKey: 'b' }
    ]
    const r = new ProviderRouter(providers)
    expect(await r.listModels()).toEqual(['m1', 'm2', 'lab::m1', 'lab::m2'])
    await text(r.stream(req('lab::m2'), new AbortController().signal))
    await text(r.stream(req('m1'), new AbortController().signal))
    expect(p2.hits.at(-1)!.body.model).toBe('m2')
    expect(p2.hits.at(-1)!.headers.authorization).toBe('Bearer b')
    expect(p1.hits.at(-1)!.body.model).toBe('m1')
    p1.close(); p2.close()
  })

  it('reports a failing provider in its group instead of failing the list', async () => {
    const ok = await fake()
    const r = new ProviderRouter([
      { id: 'default', name: 'Custom', kind: 'openai', baseUrl: `${ok.host}/v1`, apiKey: 'a' },
      { id: 'az', name: 'Azure', kind: 'azure', baseUrl: '', apiKey: 'k' },
      { id: 'off', name: 'Off', kind: 'openai', baseUrl: 'http://nowhere', apiKey: '', enabled: false }
    ])
    const g = await r.listGroups()
    expect(g.map((x) => x.provider)).toEqual(['default', 'az'])
    expect(g[1].error).toMatch(/host/i)
    expect(await r.listModels()).toEqual(['m1', 'm2'])
    expect(() => r.stream(req('off::m1'), new AbortController().signal)).toThrow(/not configured or is disabled/)
    ok.close()
  })

  it('does not reroute bare ids to another provider when the primary is disabled', async () => {
    const ok = await fake()
    const r = new ProviderRouter([
      { id: 'default', name: 'Custom', kind: 'openai', baseUrl: 'http://nowhere', apiKey: '', enabled: false },
      { id: 'two', name: 'Two', kind: 'openai', baseUrl: `${ok.host}/v1`, apiKey: 'a' }
    ])
    expect(() => r.stream(req('m1'), new AbortController().signal)).toThrow(/"Custom" is not configured or is disabled/)
    expect((await r.listGroups())[0].models).toEqual(['two::m1', 'two::m2'])
    ok.close()
  })

  it('model id helpers', () => {
    expect(splitModel('lab::anthropic/claude')).toEqual({ provider: 'lab', model: 'anthropic/claude' })
    expect(bareModel('anthropic/claude')).toBe('anthropic/claude')
    expect(providerId('Azure OpenAI', ['azure-openai'])).toBe('azure-openai-2')
  })
})

describe('migrateProviders', () => {
  const fb: ProviderEntry = { id: 'default', name: 'Custom endpoint', kind: 'openai', baseUrl: 'http://127.0.0.1:4141/v1', apiKey: 'local' }
  const dec = (e?: string) => (e ? `plain(${e})` : undefined)
  it('turns a pre-0.8 single endpoint into the primary provider', () => {
    const r = migrateProviders({ baseUrl: 'http://proxy/v1', apiKeyEnc: 'X', reasoning: 'high' }, fb, dec)
    expect(r).toEqual({ reasoning: 'high', providers: [{ ...fb, baseUrl: 'http://proxy/v1', apiKey: 'plain(X)' }] })
  })
  it('decrypts per-provider keys and leaves settings without providers alone', () => {
    expect(migrateProviders({ providers: [{ ...fb, apiKey: undefined, apiKeyEnc: 'Y' }] }, fb, dec).providers![0].apiKey).toBe('plain(Y)')
    expect(migrateProviders({ reasoning: 'low' }, fb, dec)).toEqual({ reasoning: 'low' })
  })
})
