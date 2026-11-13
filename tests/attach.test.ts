import { describe, expect, it } from 'vitest'
import { compressText, encodeWithin, fitDims, pptxToText, xlsxSharedStrings, xlsxSheetText, DEFAULT_LIMITS } from '../src/shared/attach'
import { buildUserContent, fitRequest, OMITTED_IMAGE, textOf } from '../src/engine/content'
import { estimateTokens, splitHistoryTurns } from '../src/engine/compact'
import type { Message } from '../src/engine/types'

describe('image sizing', () => {
  it('fits the long edge and never upscales', () => {
    expect(fitDims(4000, 3000, 1568)).toEqual({ width: 1568, height: 1176 })
    expect(fitDims(800, 600, 1568)).toEqual({ width: 800, height: 600 })
  })

  it('steps quality down, then size, until under the byte cap', () => {
    const calls: string[] = []
    // fake encoder: bytes proportional to pixels * quality
    const enc = (w: number, h: number, q: number) => { calls.push(`${w}x${h}@${q}`); return { length: (w * h * q) / 100 } }
    const r = encodeWithin(2000, 1000, { ...DEFAULT_LIMITS, imageMaxKB: 400 }, enc)
    expect(r.bytes.length).toBeLessThanOrEqual(400 * 1024)
    expect(calls[0]).toBe('1568x784@82')
    expect(calls).toContain('1568x784@55')
    expect(r.width).toBeLessThan(1568)
  })
})

describe('text compression', () => {
  it('normalizes whitespace and keeps head + tail past the cap', () => {
    expect(compressText('a  \r\n\n\n\nb', 100)).toEqual({ text: 'a\n\nb', truncated: false, originalChars: 4 })
    const r = compressText('H'.repeat(700) + 'T'.repeat(300), 100)
    expect(r.truncated).toBe(true)
    expect(r.text.startsWith('H'.repeat(70))).toBe(true)
    expect(r.text.endsWith('T'.repeat(30))).toBe(true)
    expect(r.text).toContain('900 characters omitted')
  })
})

describe('office extraction', () => {
  it('reads pptx slide runs as paragraphs', () => {
    const slide = '<p:sp><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p><a:p><a:r><a:t>R&amp;D</a:t></a:r></a:p></p:sp>'
    expect(pptxToText([slide])).toBe('--- slide 1 ---\nHello world\nR&D')
  })

  it('reads xlsx cells with shared strings, numbers, inline strings and gaps', () => {
    const shared = xlsxSharedStrings('<sst><si><t>Item</t></si><si><r><t>Pri</t></r><r><t>ce</t></r></si></sst>')
    expect(shared).toEqual(['Item', 'Price'])
    const sheet = '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Milk</t></is></c><c r="C2"><v>3.49</v></c></row><row r="3"><c r="A3"/></row></sheetData>'
    expect(xlsxSheetText(sheet, shared)).toBe('Item\tPrice\nMilk\t\t3.49')
  })
})

const img = (url = 'data:image/jpeg;base64,' + 'A'.repeat(1000)) => ({ kind: 'image' as const, name: 'shot.png', dataUrl: url, width: 10, height: 10 })

describe('user content', () => {
  it('stays a plain string without images and inlines documents', () => {
    const c = buildUserContent('summarize', [{ kind: 'text', name: 'a.md', text: '# A' }])
    expect(c).toBe('summarize\n\n<attachment name="a.md">\n# A\n</attachment>')
  })

  it('adds captioned image parts and textOf flattens them', () => {
    const c = buildUserContent('', [img()])
    expect(Array.isArray(c)).toBe(true)
    expect(textOf(c)).toBe('Please take a look at the attached file(s).\nAttached image: shot.png (10×10)\n[image]')
  })

  it('splits turns and estimates tokens without counting base64 bytes', () => {
    const h: Message[] = [{ role: 'user', content: buildUserContent('look', [img('data:image/jpeg;base64,' + 'A'.repeat(400000))]) }, { role: 'assistant', content: 'ok' }]
    expect(splitHistoryTurns(h)[0].user).toContain('look')
    expect(estimateTokens(h)).toBeLessThan(3000)
  })
})

describe('request budget', () => {
  const turn = (t: string, withImg: boolean): Message[] => [{ role: 'user', content: buildUserContent(t, withImg ? [img()] : []) }, { role: 'assistant', content: 'ok' }]
  const images = (ms: Message[]) => ms.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : [])).length

  it('keeps images only from the last N user turns, without mutating input', () => {
    const ms = [...turn('1', true), ...turn('2', true), ...turn('3', false)]
    const out = fitRequest(ms, { maxBytes: 1e9, imageTurns: 2 })
    expect(images(out)).toBe(1)
    expect(textOf((out[0] as any).content)).toContain(OMITTED_IMAGE)
    expect(images(ms)).toBe(2)
  })

  it('drops the oldest images until the body fits', () => {
    const ms = [...turn('1', true), ...turn('2', true)]
    const out = fitRequest(ms, { maxBytes: JSON.stringify(ms).length - 500, imageTurns: 0 })
    expect(images(out)).toBe(1)
    expect(Array.isArray(out[2].content) && out[2].content.some((p) => p.type === 'image_url')).toBe(true)
  })
})
