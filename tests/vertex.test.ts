import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VertexAdapter, toAnthropic, anthropicDeltas } from '../src/engine/adapter/vertex'
import { signJwt } from '../src/engine/adapter/vertex-auth'
import { parseVertexModels, vertexLinesFromProxy } from '../src/shared/providers'
import { Assembler } from '../src/engine/adapter/assemble'
import type { Delta, Message } from '../src/engine/types'

interface Hit { url: string; headers: http.IncomingHttpHeaders; body: any; raw: string }

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** Fake Google: /token mints tokens, Claude streamRawPredict streams Anthropic SSE, openapi streams OpenAI SSE. */
function fakeGoogle(opts: { failFirst?: number } = {}): Promise<{ host: string; hits: Hit[]; close(): void }> {
  const hits: Hit[] = []
  let n = 0, fails = opts.failFirst ?? 0
  return new Promise((res) => {
    const s = http.createServer((req, rs) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        const url = req.url ?? ''
        let body: any = null
        try { body = JSON.parse(b) } catch { body = Object.fromEntries(new URLSearchParams(b)) }
        hits.push({ url, headers: req.headers, body, raw: b })
        if (url === '/token') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ access_token: `tok${++n}`, expires_in: 3600 })); return }
        if (fails > 0) { fails--; rs.writeHead(401); rs.end('{"error":{"message":"expired"}}'); return }
        rs.writeHead(200, { 'content-type': 'text/event-stream' })
        if (url.includes(':streamRawPredict')) {
          const ev = (o: unknown) => rs.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`)
          ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } } })
          ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
          ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
          ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
          ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } })
          ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } })
          ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } })
          ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } })
          ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } })
          ev({ type: 'content_block_stop', index: 2 })
          ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } })
          ev({ type: 'message_stop' })
          rs.end()
          return
        }
        const isDescribe = JSON.stringify(body).includes('eyes for a text-only')
        rs.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: isDescribe ? 'A red square' : 'ok' } }] })}\n\n`)
        rs.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
        rs.end('data: [DONE]\n\n')
      })
    }).listen(0, '127.0.0.1', () => res({ host: `http://127.0.0.1:${(s.address() as any).port}`, hits, close: () => s.close() }))
  })
}

const tmp: string[] = []
function keyFile(host: string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vx-')), 'sa.json')
  fs.writeFileSync(f, JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: pem, token_uri: `${host}/token` }))
  tmp.push(path.dirname(f))
  return f
}
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true }) })

async function collect(it: AsyncIterable<Delta>) { const a = new Assembler(); const ds: Delta[] = []; for await (const d of it) { ds.push(d); a.push(d) } return { ds, msg: a.message() } }
const sig = () => new AbortController().signal

describe('Vertex auth', () => {
  it('signs a verifiable RS256 JWT for the cloud-platform scope', () => {
    const jwt = signJwt('bot@p.iam', pem, 'https://oauth2.googleapis.com/token', 1000)
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ iss: 'bot@p.iam', aud: 'https://oauth2.googleapis.com/token', iat: 1000, exp: 4600, scope: 'https://www.googleapis.com/auth/cloud-platform' })
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  })
})

describe('Vertex adapter', () => {
  it('streams Claude via streamRawPredict with thinking, tools, usage and cache breakpoints', async () => {
    const g = await fakeGoogle()
    const a = new VertexAdapter({ project: 'proj', location: 'global', credentialsPath: keyFile(g.host), models: ['anthropic/claude-sonnet-5 @us-east5'], endpoint: g.host })
    const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }]
    const { ds, msg } = await collect(a.stream({ model: 'anthropic/claude-sonnet-5', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools, reasoning: 'high' }, sig()))
    expect(g.hits[0].url).toBe('/token')
    expect(g.hits[0].body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const call = g.hits[1]
    expect(call.url).toBe('/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:streamRawPredict')
    expect(call.headers.authorization).toBe('Bearer tok1')
    expect(call.body).toMatchObject({ anthropic_version: 'vertex-2023-10-16', stream: true, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
    expect(call.body.temperature).toBeUndefined()
    expect(call.body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(call.body.tools[0]).toMatchObject({ name: 'read_file', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } })
    expect(msg.content).toBe('Hello')
    expect(msg.reasoning).toBe('hmm')
    expect(msg.tool_calls).toEqual([{ id: 'tu1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }])
    expect(ds).toContainEqual({ type: 'usage', prompt: 115, completion: 42, cached: 100, cacheWrite: 5 })
    expect(ds.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
    g.close()
  })

  it('uses the OpenAI-compatible endpoint for other models, with Gemini thinking_config', async () => {
    const g = await fakeGoogle()
    const a = new VertexAdapter({ project: 'proj', credentialsPath: keyFile(g.host), models: ['google/gemini-2.5-pro', 'zai-org/glm-5.2-maas'], endpoint: g.host })
    expect((await collect(a.stream({ model: 'google/gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], reasoning: 'medium' }, sig()))).msg.content).toBe('ok')
    const call = g.hits[1]
    expect(call.url).toBe('/v1/projects/proj/locations/global/endpoints/openapi/chat/completions')
    expect(call.body.extra_body).toEqual({ google: { thinking_config: { include_thoughts: true } } })
    expect(call.body.reasoning_effort).toBeUndefined()
    expect(call.body.include_reasoning).toBeUndefined()
    await collect(a.stream({ model: 'zai-org/glm-5.2-maas', messages: [{ role: 'user', content: 'hi' }], reasoning: 'low' }, sig()))
    expect(g.hits.at(-1)!.body).toMatchObject({ model: 'zai-org/glm-5.2-maas', reasoning_effort: 'low' })
    expect(g.hits.filter((h) => h.url === '/token').length).toBe(1)
    g.close()
  })

  it('refreshes the token once on 401', async () => {
    const g = await fakeGoogle({ failFirst: 1 })
    const a = new VertexAdapter({ project: 'proj', credentialsPath: keyFile(g.host), models: ['google/gemini-2.5-pro'], endpoint: g.host })
    expect((await collect(a.stream({ model: 'google/gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }, sig()))).msg.content).toBe('ok')
    expect(g.hits.map((h) => h.url.split('/').pop())).toEqual(['token', 'completions', 'token', 'completions'])
    expect(g.hits[3].headers.authorization).toBe('Bearer tok2')
    g.close()
  })

  it('transcribes images for text-only models with the vision model, once per image', async () => {
    const g = await fakeGoogle()
    const a = new VertexAdapter({ project: 'proj', credentialsPath: keyFile(g.host), models: ['zai-org/glm-5.2-maas describe', 'google/gemini-3.8-flash'], endpoint: g.host })
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'what is it' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
    await collect(a.stream({ model: 'zai-org/glm-5.2-maas', messages: msgs }, sig()))
    await collect(a.stream({ model: 'zai-org/glm-5.2-maas', messages: msgs }, sig()))
    const calls = g.hits.filter((h) => h.url !== '/token')
    expect(calls.map((h) => h.body.model)).toEqual(['google/gemini-3.8-flash', 'zai-org/glm-5.2-maas', 'zai-org/glm-5.2-maas'])
    const sent = calls[1].body.messages[0].content
    expect(sent[1].type).toBe('text')
    expect(sent[1].text).toContain('A red square')
    expect(JSON.stringify(calls[1].body)).not.toContain('image_url')
    g.close()
  })

  it('errors clearly when the project or key file is missing', async () => {
    await expect(new VertexAdapter({ project: '', models: ['a/b'] }).listModels()).rejects.toThrow(/project is not set/)
    const a = new VertexAdapter({ project: 'p', credentialsPath: '/nope/sa.json', models: ['google/x'], endpoint: 'http://127.0.0.1:1' })
    await expect(collect(a.stream({ model: 'google/x', messages: [{ role: 'user', content: 'hi' }] }, sig()))).rejects.toThrow(/key not found/)
  })
})

describe('Anthropic translation', () => {
  it('maps tool calls and results, merges same-role turns, converts images', () => {
    const b = toAnthropic([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"d":"."}' } }, { id: 'c2', type: 'function', function: { name: 'pwd', arguments: '' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a b' },
      { role: 'tool', tool_call_id: 'c2', content: '/x' }
    ], {}, 'off')
    expect(b.messages).toHaveLength(3)
    expect(b.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } })
    expect(b.messages[1].content).toEqual([{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'ls', input: { d: '.' } }, { type: 'tool_use', id: 'c2', name: 'pwd', input: {} }])
    expect(b.messages[2].content.map((x: any) => x.tool_use_id)).toEqual(['c1', 'c2'])
    expect(b.thinking).toBeUndefined()
  })

  it('marks the final message and the previous user turn for caching (1h ttl)', () => {
    const b = toAnthropic([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }], {}, '1h')
    expect(b.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(b.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(b.messages[1].content[0].cache_control).toBeUndefined()
  })

  it('maps max_tokens stop to length', async () => {
    async function* ev() { yield '{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}'; yield '{"type":"message_stop"}' }
    const out: Delta[] = []
    for await (const d of anthropicDeltas(ev())) out.push(d)
    expect(out.at(-1)).toEqual({ type: 'finish', reason: 'length' })
  })
})

describe('Vertex model lines', () => {
  it('parses location and describe flags, skipping comments and duplicates', () => {
    expect(parseVertexModels(['anthropic/claude-opus-5', ' google/gemini-2.5-pro @us-central1 ', '# comment', '', 'zai-org/glm-5.2-maas describe', 'anthropic/claude-opus-5'])).toEqual([
      { id: 'anthropic/claude-opus-5', location: 'global', vision: true },
      { id: 'google/gemini-2.5-pro', location: 'us-central1', vision: true },
      { id: 'zai-org/glm-5.2-maas', location: 'global', vision: 'describe' }
    ])
  })
  it('imports models from a model-proxy models.json', () => {
    expect(vertexLinesFromProxy({ default_location: 'global', models: [{ id: 'a/x', location: 'global', vision: true }, { id: 'b/y', location: 'us-east5', vision: 'describe' }] })).toEqual(['a/x', 'b/y @us-east5 describe'])
  })
})
