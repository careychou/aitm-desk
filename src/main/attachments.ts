import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { nativeImage, type NativeImage } from 'electron'
import type { Attachment } from '../engine/content'
import { IMAGE_TOKENS } from '../engine/content'
import { compressText, encodeWithin, fmtBytes, fmtTokens, pptxToText, xlsxSharedStrings, xlsxSheetText, type AttachLimits, type AttachMeta } from '../shared/attach'

/** Raw input from the renderer: a file path (drop / picker / Finder copy) or bytes (pasted screenshot). */
export interface AttachInput { path?: string; name?: string; data?: Uint8Array }
export interface Prepared { id: string; att?: Attachment; meta: AttachMeta; error?: string }

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'])
const PASS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const TEXTUTIL = new Set(['doc', 'docx', 'rtf', 'rtfd', 'odt', 'html', 'htm', 'webarchive', 'wordml'])
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_INPUT = 200 * 1024 * 1024
const tmp = () => { const d = path.join(os.tmpdir(), 'aitm-attach'); fs.mkdirSync(d, { recursive: true }); return d }
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 60000 })

export async function prepareAttachment(input: AttachInput, l: AttachLimits): Promise<Prepared> {
  const id = randomUUID()
  let file = input.path ?? ''
  const name = input.name || path.basename(file) || 'pasted'
  try {
    if (!file) {
      if (!input.data) throw new Error('nothing to attach')
      file = path.join(tmp(), `${id}-${name.replace(/[^\w.-]/g, '_')}`)
      fs.writeFileSync(file, input.data)
    }
    const st = fs.statSync(file)
    if (st.isDirectory()) throw new Error('folders cannot be attached; mention the path in your prompt instead')
    if (st.size > MAX_INPUT) throw new Error(`file is ${fmtBytes(st.size)}; the limit is ${fmtBytes(MAX_INPUT)}`)
    const ext = path.extname(name).slice(1).toLowerCase() || sniff(file)
    if (IMAGE.has(ext)) return { id, ...image(file, name, ext, st.size, l) }
    if (ext === 'pdf') return { id, ...(await pdf(file, name, st.size, l)) }
    let text: string
    if (TEXTUTIL.has(ext)) text = run('textutil', ['-convert', 'txt', '-stdout', file]).toString('utf8')
    else if (ext === 'pptx') text = pptx(file)
    else if (ext === 'xlsx') text = xlsx(file)
    else {
      const buf = fs.readFileSync(file)
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`.${ext || 'binary'} files are not supported; supported: images, PDF, Office (docx/xlsx/pptx), RTF/HTML and text/code files`)
      text = buf.toString('utf8')
    }
    return { id, ...doc(name, text, st.size, l) }
  } catch (e: any) {
    return { id, meta: { name, kind: 'doc', info: 'Could not attach' }, error: e?.message ?? String(e) }
  } finally {
    if (!input.path && file) fs.rmSync(file, { force: true })
  }
}

function sniff(file: string): string {
  const h = Buffer.alloc(12)
  const fd = fs.openSync(file, 'r'); fs.readSync(fd, h, 0, 12, 0); fs.closeSync(fd)
  if (h[0] === 0x89 && h[1] === 0x50) return 'png'
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg'
  if (h.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (h.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (h.toString('ascii', 0, 4) === '%PDF') return 'pdf'
  return ''
}

function load(file: string): NativeImage {
  let img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    // formats NSImage cannot open directly (some HEIC/TIFF): let macOS `sips` convert first
    const out = path.join(tmp(), `${randomUUID()}.png`)
    run('sips', ['-s', 'format', 'png', file, '--out', out])
    img = nativeImage.createFromPath(out)
    fs.rmSync(out, { force: true })
  }
  if (img.isEmpty()) throw new Error('unreadable image')
  return img
}

function image(file: string, name: string, ext: string, size: number, l: AttachLimits) {
  const img = load(file)
  const { width: w, height: h } = img.getSize()
  let data: Buffer, mime: string, dims = { width: w, height: h }
  if (PASS.has(ext) && Math.max(w, h) <= l.imageMaxEdge && size <= Math.min(400 * 1024, l.imageMaxKB * 1024)) {
    data = fs.readFileSync(file); mime = MIME[ext]
  } else {
    const r = encodeWithin(w, h, l, (width, height, q) => resized(img, w, width, height).toJPEG(q))
    data = r.bytes; mime = 'image/jpeg'; dims = { width: r.width, height: r.height }
    // screenshots / diagrams often stay crisper and no bigger as PNG
    if (ext === 'png') {
      const png = resized(img, w, r.width, r.height).toPNG()
      if (png.length <= Math.min(data.length * 1.25, l.imageMaxKB * 1024)) { data = png; mime = 'image/png' }
    }
  }
  const thumb = img.resize({ height: Math.min(96, h), quality: 'good' }).toJPEG(70)
  const att: Attachment = { kind: 'image', name, dataUrl: `data:${mime};base64,${data.toString('base64')}`, width: dims.width, height: dims.height }
  const shrunk = data.length < size || dims.width !== w
  const info = `${shrunk ? `${fmtBytes(size)} → ` : ''}${fmtBytes(data.length)} · ${dims.width}×${dims.height} · ${fmtTokens(IMAGE_TOKENS)}`
  return { att, meta: { name, kind: 'image' as const, thumb: `data:image/jpeg;base64,${thumb.toString('base64')}`, info } }
}

const resized = (img: NativeImage, w: number, width: number, height: number) => (width === w ? img : img.resize({ width, height, quality: 'best' }))

function doc(name: string, raw: string, size: number, l: AttachLimits, extra = '') {
  const c = compressText(raw, l.docMaxChars)
  if (!c.text) throw new Error('no readable text found')
  const note = c.truncated ? `truncated: kept ${c.text.length.toLocaleString('en-US')} of ${c.originalChars.toLocaleString('en-US')} characters` : undefined
  const att: Attachment = { kind: 'text', name, text: c.text, note: [extra, note].filter(Boolean).join('; ') || undefined }
  const info = `${fmtBytes(size)}${extra ? ` · ${extra}` : ''} · ${fmtTokens(Math.round(c.text.length / 4))}${c.truncated ? ' · trimmed' : ''}`
  return { att, meta: { name, kind: 'doc' as const, info } }
}

async function pdf(file: string, name: string, size: number, l: AttachLimits) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const doc0 = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)))
  const { totalPages, text } = await extractText(doc0, { mergePages: false })
  const pages = (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`)
  if ((text as string[]).join('').trim().length < 20 * totalPages) {
    // scanned PDF without a text layer: send the first page as an image instead
    const out = path.join(tmp(), `${randomUUID()}.png`)
    run('sips', ['-s', 'format', 'png', file, '--out', out])
    try {
      const r = image(out, name, 'png', fs.statSync(out).size, l)
      r.meta.info = `scanned PDF (${totalPages} p) · page 1 as image · ${r.meta.info.split(' · ').slice(-2).join(' · ')}`
      return r
    } finally { fs.rmSync(out, { force: true }) }
  }
  return doc(name, pages.join('\n\n'), size, l, `${totalPages} page${totalPages === 1 ? '' : 's'}`)
}

const zipList = (file: string) => run('unzip', ['-Z1', file]).toString('utf8').split('\n').filter(Boolean)
const zipRead = (file: string, entry: string) => run('unzip', ['-p', file, entry]).toString('utf8')
const byNum = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1])

function pptx(file: string): string {
  const slides = zipList(file).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e)).sort(byNum)
  return pptxToText(slides.map((s) => zipRead(file, s)))
}

function xlsx(file: string): string {
  const entries = zipList(file)
  const shared = entries.includes('xl/sharedStrings.xml') ? xlsxSharedStrings(zipRead(file, 'xl/sharedStrings.xml')) : []
  const names = [...zipRead(file, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1])
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).sort(byNum)
  return sheets.map((s, i) => `--- sheet: ${names[i] ?? i + 1} ---\n${xlsxSheetText(zipRead(file, s), shared)}`).join('\n\n')
}
