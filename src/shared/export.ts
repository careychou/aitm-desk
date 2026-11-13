/** Minimal structural view of renderer UI items needed for export. */
export type ExportItem =
  | { t: 'user'; text: string }
  | { t: 'answer'; text: string }
  | { t: 'assistant'; agentId: string; text: string; reasoning: string }
  | { t: 'tool'; name: string; args: string; output?: string; ok?: boolean }
  | { t: 'agent'; name: string; mode: string; prompt: string; status: string; finalText: string; children: ExportItem[] }
  | { t: 'error'; text: string }

export interface ExportOptions {
  title: string
  cwd: string
  model: string
  /** 0-based turn indexes to include; omit for all. */
  turns?: number[]
  includeTools?: boolean
  includeThinking?: boolean
  now?: Date
}

export const EXPORT_MARKER = 'aitm-desk-export: 1'

/** Splits items into turns; each turn starts at a user item. Leading non-user items are dropped. */
export function splitTurns<T extends { t: string }>(items: T[]): T[][] {
  const turns: T[][] = []
  for (const it of items) {
    if (it.t === 'user') turns.push([it])
    else if (turns.length) turns[turns.length - 1].push(it)
  }
  return turns
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s)
const quote = (s: string) => s.trim().split('\n').map((l) => `> ${l}`).join('\n')
const fence = (s: string, lang = '') => {
  const ticks = s.includes('```') ? '````' : '```'
  return `${ticks}${lang}\n${s}\n${ticks}`
}

function renderItems(items: ExportItem[], o: ExportOptions, depth: number): string[] {
  const out: string[] = []
  for (const it of items) {
    switch (it.t) {
      case 'answer': out.push(`**User answered:** ${it.text}`); break
      case 'assistant':
        if (o.includeThinking && it.reasoning.trim()) out.push(`<details><summary>Thinking</summary>\n\n${quote(it.reasoning)}\n\n</details>`)
        if (it.text.trim()) out.push(it.text.trim())
        break
      case 'tool':
        if (o.includeTools) out.push(`**Tool \`${it.name}\`**${it.ok === false ? ' (failed)' : ''}\n\n${fence(clip(it.args, 2000), 'json')}${it.output ? `\n\n${fence(clip(it.output, 4000))}` : ''}`)
        break
      case 'agent': {
        const head = `**Sub-agent \`${it.name}\`** (${it.mode}, ${it.status})\n\n${quote(`Task: ${it.prompt}`)}`
        const inner = o.includeTools ? renderItems(it.children, o, depth + 1) : []
        const result = it.finalText.trim() ? `\n\n**Result:**\n\n${it.finalText.trim()}` : ''
        out.push(head + (inner.length ? `\n\n${inner.join('\n\n')}` : '') + result)
        break
      }
      case 'error': out.push(`> ⚠ ${it.text}`); break
    }
  }
  return out
}

/** Renders selected turns of a session as a self-describing Markdown document. */
export function exportMarkdown(items: ExportItem[], o: ExportOptions): string {
  const all = splitTurns(items)
  const pick = o.turns ? [...new Set(o.turns)].filter((i) => i >= 0 && i < all.length).sort((a, b) => a - b) : all.map((_, i) => i)
  const head = [
    '---',
    EXPORT_MARKER,
    `title: ${JSON.stringify(o.title)}`,
    `exported: ${(o.now ?? new Date()).toISOString()}`,
    `model: ${o.model}`,
    `folder: ${JSON.stringify(o.cwd)}`,
    `turns: ${pick.length === all.length ? `all (${all.length})` : `${pick.map((i) => i + 1).join(', ')} of ${all.length}`}`,
    '---',
    '',
    `# ${o.title}`,
    ''
  ]
  const body = pick.map((i) => {
    const [user, ...rest] = all[i] as ExportItem[]
    const parts = renderItems(rest, o, 0)
    return [`## Turn ${i + 1}`, '', '### User', '', (user as { text: string }).text.trim(), '', '### Assistant', '', parts.join('\n\n') || '_(no response)_'].join('\n')
  })
  return head.join('\n') + body.join('\n\n---\n\n') + '\n'
}
