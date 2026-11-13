import type { ContentPart, Message } from './types'

/** What the engine receives for one attached file, after the desktop has prepared and compressed it. */
export type Attachment =
  | { kind: 'image'; name: string; dataUrl: string; width: number; height: number }
  | { kind: 'text'; name: string; text: string; note?: string }

/** Rough per-image token cost (Claude/Gemini bill ~w*h/750, capped near 1.6k after their own downscale). */
export const IMAGE_TOKENS = 1600

/** Plain text of a message content, with images shown as a marker. */
export function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}

const attr = (s: string) => s.replace(/"/g, "'")

/** Builds user content: prompt + inlined documents as text, then each image with a short caption. */
export function buildUserContent(prompt: string, atts: Attachment[] = []): string | ContentPart[] {
  const docs = atts.filter((a): a is Extract<Attachment, { kind: 'text' }> => a.kind === 'text')
  const imgs = atts.filter((a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image')
  let text = prompt.trim() || (atts.length ? 'Please take a look at the attached file(s).' : '')
  for (const d of docs) text += `\n\n<attachment name="${attr(d.name)}"${d.note ? ` note="${attr(d.note)}"` : ''}>\n${d.text}\n</attachment>`
  if (!imgs.length) return text
  const parts: ContentPart[] = [{ type: 'text', text }]
  for (const i of imgs) {
    parts.push({ type: 'text', text: `Attached image: ${i.name} (${i.width}×${i.height})` })
    parts.push({ type: 'image_url', image_url: { url: i.dataUrl } })
  }
  return parts
}

export interface RequestBudget {
  /** Upper bound for the serialized request body (Vertex rejects > 30 MB). */
  maxBytes: number
  /** Only the images from the last N user messages are re-sent; older ones become a text note. 0 = keep all. */
  imageTurns: number
}

export const OMITTED_IMAGE = '[An earlier image was omitted here to save context. Ask the user to re-attach it if you need to see it again.]'

const hasImage = (m: Message) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')

/**
 * Returns messages that fit the budget: images outside the last `imageTurns` user messages are replaced by a note,
 * then the oldest remaining images are dropped until the JSON body is under `maxBytes`. Never mutates the input.
 */
export function fitRequest(messages: Message[], b: RequestBudget): Message[] {
  if (!messages.some(hasImage)) return messages
  const out: Message[] = messages.map((m) => (hasImage(m) ? { ...m, content: (m.content as ContentPart[]).map((p) => ({ ...p })) } as Message : m))
  const omit = (m: Message) => {
    m.content = (m.content as ContentPart[]).map((p) => (p.type === 'image_url' ? { type: 'text', text: OMITTED_IMAGE } : p)) as any
  }
  if (b.imageTurns > 0) {
    const users = out.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0)
    const recent = new Set(users.slice(-b.imageTurns))
    out.forEach((m, i) => { if (hasImage(m) && !recent.has(i)) omit(m) })
  }
  const size = () => JSON.stringify(out).length
  if (size() <= b.maxBytes) return out
  for (const m of out) {
    if (!hasImage(m)) continue
    const parts = m.content as ContentPart[]
    for (let k = 0; k < parts.length; k++) {
      if (parts[k].type !== 'image_url') continue
      parts[k] = { type: 'text', text: OMITTED_IMAGE }
      if (size() <= b.maxBytes) return out
    }
  }
  return out
}
