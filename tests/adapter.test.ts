import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { parseSSE } from '../src/engine/adapter/sse'
import { Assembler } from '../src/engine/adapter/assemble'
import { OpenAIAdapter } from '../src/engine/adapter/openai'
import type { Delta } from '../src/engine/types'

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p)
}

describe('parseSSE', () => {
  it('splits data lines across chunk boundaries and stops at [DONE]', async () => {
    const out: string[] = []
    for await (const d of parseSSE(chunks('data: {"a":', '1}\n\ndata: {"b":2}\n', '\ndata: [DONE]\n\ndata: {"c":3}\n\n'))) out.push(d)
    expect(out).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('Assembler', () => {
  it('assembles fragmented tool calls, text and reasoning', () => {
    const a = new Assembler()
    const ds: Delta[] = [
      { type: 'reasoning', text: 'think ' },
      { type: 'reasoning', text: 'more' },
      { type: 'text', text: 'Hi' },
      { type: 'tool_call', index: 0, id: 'c1', name: 'shell', args: '{"comm' },
      { type: 'tool_call', index: 0, args: 'and":"ls"}' },
      { type: 'tool_call', index: 1, id: 'c2', name: 'glob', args: '{}' },
      { type: 'finish', reason: 'tool_calls' }
    ]
    ds.forEach((d) => a.push(d))
    const m = a.message()
    expect(m).toEqual({
      role: 'assistant', content: 'Hi', reasoning: 'think more',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
        { id: 'c2', type: 'function', function: { name: 'glob', arguments: '{}' } }
      ]
    })
  })
  it('generates ids when the model omits them', () => {
    const a = new Assembler()
    a.push({ type: 'tool_call', index: 0, name: 'x', args: '{}' })
    expect(a.message().tool_calls![0].id).toMatch(/^call_/)
  })
})

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((res) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port
      res({ url: `http://127.0.0.1:${port}/v1`, close: () => s.close() })
    })
  })
}

describe('OpenAIAdapter', () => {
  it('streams deltas from a Claude-style whole-args chunk', async () => {
    let body: any
    const srv = await server((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        body = JSON.parse(b)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"hm"}}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"shell","arguments":"{\\"command\\": \\"ls\\"}"}}]}}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3,"cache_write_tokens":1}}}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    const ad = new OpenAIAdapter({ baseUrl: srv.url, apiKey: 'k' })
    const out: Delta[] = []
    for await (const d of ad.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) out.push(d)
    srv.close()
    expect(body.stream).toBe(true)
    expect(out).toContainEqual({ type: 'reasoning', text: 'hm' })
    expect(out).toContainEqual({ type: 'tool_call', index: 0, id: 't1', name: 'shell', args: '{"command": "ls"}' })
    expect(out).toContainEqual({ type: 'finish', reason: 'tool_calls' })
    expect(out).toContainEqual({ type: 'usage', prompt: 5, completion: 7, cached: 3, cacheWrite: 1 })
  })

  it('throws a readable error on 401', async () => {
    const srv = await server((_req, res) => { res.writeHead(401); res.end('{"error":{"message":"bad proxy api key"}}') })
    const ad = new OpenAIAdapter({ baseUrl: srv.url, apiKey: 'k' })
    await expect(async () => { for await (const _ of ad.stream({ model: 'm', messages: [] }, new AbortController().signal)); }).rejects.toThrow(/401.*bad proxy api key/)
    srv.close()
  })
})

import { ThinkSplitter } from '../src/engine/adapter/openai'

describe('ThinkSplitter', () => {
  it('splits <think> blocks across chunk boundaries', () => {
    const t = new ThinkSplitter()
    const out = [...t.push('<thi'), ...t.push('nk>plan A</th'), ...t.push('ink>Answer'), ...t.flush()]
    const join = (k: string) => out.filter((d) => d.type === k).map((d: any) => d.text).join('')
    expect(join('reasoning')).toBe('plan A')
    expect(join('text')).toBe('Answer')
  })
  it('passes plain text through, including a lone "<"', () => {
    const t = new ThinkSplitter()
    const out = [...t.push('a < b'), ...t.push(' ok'), ...t.flush()]
    expect(out.map((d: any) => d.text).join('')).toBe('a < b ok')
    expect(out.every((d) => d.type === 'text')).toBe(true)
  })
})

describe('OpenAIAdapter reasoning', () => {
  it('sends include_reasoning and routes Gemini thought chunks to reasoning', async () => {
    let body: any
    const srv = await server((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        body = JSON.parse(b)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"index":0,"delta":{"content":"**Plan**","extra_content":{"google":{"thought":true}}}}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    const ad = new OpenAIAdapter({ baseUrl: srv.url, apiKey: 'k' })
    const out: Delta[] = []
    for await (const d of ad.stream({ model: 'm', messages: [], reasoning: 'high' }, new AbortController().signal)) out.push(d)
    srv.close()
    expect(body.include_reasoning).toBe(true)
    expect(body.reasoning_effort).toBe('high')
    expect(out).toContainEqual({ type: 'reasoning', text: '**Plan**\n\n' })
    expect(out).toContainEqual({ type: 'text', text: 'Done' })
  })
})
