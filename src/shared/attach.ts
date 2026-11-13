/** Pure helpers for preparing attachments (no Electron / fs), shared by the main process and tests. */

export interface AttachLimits {
  /** Longest image edge after downscaling (Claude/Gemini downsample to ~1568 anyway, so no visible loss). */
  imageMaxEdge: number
  /** JPEG quality to start from (1-100). */
  imageQuality: number
  /** Per-image size cap after encoding, in KB; quality then size step down until it fits. */
  imageMaxKB: number
  /** Max characters kept from a document; the middle is cut beyond this. */
  docMaxChars: number
}

export const DEFAULT_LIMITS: AttachLimits = { imageMaxEdge: 1568, imageQuality: 82, imageMaxKB: 1500, docMaxChars: 80000 }

/** UI-side description of a prepared attachment (stored with the chat for display). */
export interface AttachMeta { name: string; kind: 'image' | 'doc'; thumb?: string; info: string }

/** Scales (w, h) so the long edge is at most `maxEdge`; never upscales. */
export function fitDims(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const s = Math.min(1, maxEdge / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

/**
 * Encodes with decreasing quality, then decreasing size, until the result fits `maxBytes`.
 * `encode(width, height, quality)` does the actual work so this stays testable.
 */
export function encodeWithin<B extends { length: number }>(
  w: number, h: number, l: AttachLimits, encode: (width: number, height: number, quality: number) => B
): { bytes: B; width: number; height: number; quality: number } {
  const maxBytes = l.imageMaxKB * 1024
  let edge = Math.min(l.imageMaxEdge, Math.max(w, h))
  let best: { bytes: B; width: number; height: number; quality: number } | null = null
  for (let round = 0; round < 6; round++) {
    const d = fitDims(w, h, edge)
    for (const q of [l.imageQuality, 70, 55].filter((q, i, a) => q <= l.imageQuality && a.indexOf(q) === i)) {
      const bytes = encode(d.width, d.height, q)
      best = { bytes, ...d, quality: q }
      if (bytes.length <= maxBytes) return best
    }
    edge = Math.round(edge * 0.75)
    if (edge < 256) break
  }
  return best!
}

/** Normalizes whitespace and, past `maxChars`, keeps the head and tail with a marker in the middle. */
export function compressText(s: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const norm = s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  if (norm.length <= maxChars) return { text: norm, truncated: false, originalChars: norm.length }
  const head = Math.floor(maxChars * 0.7), tail = maxChars - head
  const cut = norm.length - head - tail
  return { text: `${norm.slice(0, head)}\n\n… [${cut.toLocaleString('en-US')} characters omitted to save context] …\n\n${norm.slice(-tail)}`, truncated: true, originalChars: norm.length }
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')

/** Text of every <a:t> run in a PowerPoint slide, one paragraph per line. */
export function pptxSlideText(xml: string): string {
  return xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join('')).filter((l) => l.trim()).join('\n')
}

export function pptxToText(slides: string[]): string {
  return slides.map((x, i) => `--- slide ${i + 1} ---\n${pptxSlideText(x)}`).join('\n\n')
}

/** Shared strings table of an .xlsx (index -> text). */
export function xlsxSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join(''))
}

/** One worksheet as tab-separated rows (formulas use their cached values). */
export function xlsxSheetText(xml: string, shared: string[]): string {
  const rows: string[] = []
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? ''
      const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1]
      const t = /t="(\w+)"/.exec(attrs)?.[1]
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]
      let val = ''
      if (t === 's' && v != null) val = shared[Number(v)] ?? ''
      else if (t === 'inlineStr') val = [...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join('')
      else if (v != null) val = decode(v)
      if (col) { const i = colIndex(col); while (cells.length < i) cells.push('') ; cells[i] = val } else cells.push(val)
    }
    if (cells.some((x) => x !== '')) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

const colIndex = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)
export const fmtTokens = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`)
