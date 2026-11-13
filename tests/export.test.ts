import { describe, it, expect } from 'vitest'
import { exportMarkdown, splitTurns, EXPORT_MARKER, type ExportItem } from '../src/shared/export'

const items: ExportItem[] = [
  { t: 'user', text: 'first question' },
  { t: 'assistant', agentId: 'main', text: '', reasoning: 'pondering' },
  { t: 'tool', name: 'shell', args: '{"command":"ls"}', output: 'a.txt', ok: true },
  { t: 'assistant', agentId: 'main', text: 'first answer', reasoning: '' },
  { t: 'user', text: 'second question' },
  { t: 'agent', name: 'reader', mode: 'sync', prompt: 'read it', status: 'completed', finalText: 'sub result', children: [{ t: 'tool', name: 'read_file', args: '{}', output: 'x', ok: true }] },
  { t: 'assistant', agentId: 'main', text: 'second answer', reasoning: '' },
  { t: 'user', text: 'third question' },
  { t: 'assistant', agentId: 'main', text: 'third answer', reasoning: '' }
]
const base = { title: 'Demo', cwd: '/tmp/x', model: 'm', now: new Date('2026-01-01T00:00:00Z') }

describe('export', () => {
  it('lists attachments under the user prompt', () => {
    const md = exportMarkdown([{ t: 'user', text: 'see this', attachments: [{ name: 'a.png', info: '120 KB' }] }], base)
    expect(md).toContain('see this\n\n📎 _a.png_ (120 KB; not included in the export)')
  })

  it('splits turns at user items', () => {
    expect(splitTurns(items).map((t) => t.length)).toEqual([4, 3, 2])
  })

  it('exports all turns with a marker header, hiding tools and thinking by default', () => {
    const md = exportMarkdown(items, base)
    expect(md.startsWith(`---\n${EXPORT_MARKER}\n`)).toBe(true)
    expect(md).toContain('turns: all (3)')
    for (const s of ['## Turn 1', 'first answer', '## Turn 3', 'third answer', 'sub result']) expect(md).toContain(s)
    expect(md).not.toContain('pondering')
    expect(md).not.toContain('a.txt')
    expect(md).not.toContain('read_file')
  })

  it('exports only selected turns, keeping original numbering', () => {
    const md = exportMarkdown(items, { ...base, turns: [2, 0] })
    expect(md).toContain('turns: 1, 3 of 3')
    expect(md).toContain('## Turn 1')
    expect(md).toContain('## Turn 3')
    expect(md).not.toContain('second question')
    expect(md.indexOf('## Turn 1')).toBeLessThan(md.indexOf('## Turn 3'))
  })

  it('includes tools (incl. sub-agent tools) and thinking when asked', () => {
    const md = exportMarkdown(items, { ...base, includeTools: true, includeThinking: true })
    expect(md).toContain('pondering')
    expect(md).toContain('**Tool `shell`**')
    expect(md).toContain('a.txt')
    expect(md).toContain('read_file')
  })
})
