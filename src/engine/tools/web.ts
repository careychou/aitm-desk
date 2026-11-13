import type { ToolDef } from './types'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
  return ENTITIES[e.toLowerCase()] ?? m
})

/** Small HTML → Markdown converter: keeps headings, links, lists, code and paragraphs; drops scripts, styles and chrome. */
export function htmlToMarkdown(html: string, base?: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|footer|iframe|template)\b[\s\S]*?<\/\1>/gi, '')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const abs = (u: string) => { try { return base ? new URL(u, base).href : u } catch { return u } }
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\n\`\`\`\n${t.replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${t.replace(/<[^>]+>/g, '')}\``)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, h, t) => { const txt = t.replace(/<[^>]+>/g, '').trim(); return txt ? `[${txt}](${abs(h)})` : '' })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, a) => (a ? `![${a}]` : ''))
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|header|main)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
  s = decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return title ? `# ${decode(title.trim())}\n\n${s}` : s
}

export const webFetch: ToolDef = {
  name: 'web_fetch',
  description: 'Fetch a URL (http/https) and return the page as Markdown (or raw HTML with raw=true). max_length default 5000, max 20000; use start_index to page through long content.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' }, max_length: { type: 'integer' }, start_index: { type: 'integer' }, raw: { type: 'boolean' } },
    required: ['url']
  },
  permission: 'url',
  summarize: (a) => String(a.url),
  async run(a, ctx) {
    const url = new URL(a.url)
    if (!/^https?:$/.test(url.protocol)) throw new Error('only http and https URLs are supported')
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
    const r = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AITM-Desk/1.0', Accept: 'text/html,application/json,text/plain,*/*' } })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`)
    const type = r.headers.get('content-type') ?? ''
    if (!/text|json|xml|javascript/.test(type) && type) return `Fetched ${r.url}: ${type} content (${r.headers.get('content-length') ?? '?'} bytes) is not text; download it with the shell tool instead.`
    const body = await r.text()
    const text = !a.raw && /html/.test(type) ? htmlToMarkdown(body, r.url) : body
    const max = Math.min(Math.max(Number(a.max_length) || 5000, 100), 20_000)
    const start = Math.max(Number(a.start_index) || 0, 0)
    const chunk = text.slice(start, start + max)
    const more = start + max < text.length ? `\n\n<content truncated: showing ${start}-${start + chunk.length} of ${text.length} chars; call again with start_index=${start + chunk.length}>` : ''
    return `Contents of ${r.url}:\n${chunk}${more}`
  }
}
