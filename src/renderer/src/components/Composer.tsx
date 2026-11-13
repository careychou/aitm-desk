import { useEffect, useRef, useState } from 'react'
import type { AttachInput, PreparedAttachment } from '../../../shared/api'

type Chip = PreparedAttachment & { pending?: boolean }

interface Props {
  busy: boolean
  /** Text to put back in the box (e.g. queued prompts dropped by Stop); `n` changes on every restore. */
  restore?: { text: string; n: number }
  model: string
  models: string[]
  cwd: string
  onModel(m: string): void
  onPickFolder?: () => void
  onSend(text: string, attachments: PreparedAttachment[]): void
  onStop(): void
  autoFocus?: boolean
  effort: Effort
  onEffort(e: Effort): void
  memories: string[]
  onAddMemory(): void
  onRemoveMemory(path: string): void
  onShare?: () => void
  tokens?: number
  onCompact?: () => void
}

export type Effort = 'off' | 'low' | 'medium' | 'high'
const EFFORTS: Array<[Effort, string]> = [['off', 'Thinking off'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort']]
const fileName = (p: string) => p.split('/').pop() ?? p

const short = (m: string) => m.split('/').pop() ?? m
const folderName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function Composer(p: Props) {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (p.autoFocus) ta.current?.focus() }, [p.autoFocus])
  useEffect(() => {
    const el = ta.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 260) + 'px' }
  }, [text])

  useEffect(() => {
    if (p.restore?.n && p.restore.text) setText((t) => (t.trim() ? `${p.restore!.text}\n\n${t}` : p.restore!.text))
  }, [p.restore?.n])

  const [atts, setAtts] = useState<Chip[]>([])
  const [dragging, setDragging] = useState(false)
  const ready = atts.filter((a) => a.att && !a.pending)
  const preparing = atts.some((a) => a.pending)

  const add = async (inputs: AttachInput[], names: string[]) => {
    if (!inputs.length) return
    const temp: Chip[] = names.map((name) => ({ id: `tmp-${Math.random()}`, meta: { name, kind: 'doc', info: 'Preparing…' }, pending: true }))
    setAtts((a) => [...a, ...temp])
    const done = await window.desk.prepareAttachments(inputs)
    setAtts((a) => [...a.filter((x) => !temp.includes(x)), ...done])
    ta.current?.focus()
  }
  const addFiles = async (files: File[]) => {
    const inputs: AttachInput[] = [], names: string[] = []
    for (const f of files) {
      const fp = window.desk.pathForFile(f)
      const name = fp ? fp.split('/').pop()! : f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
      inputs.push(fp ? { path: fp } : { name, data: new Uint8Array(await f.arrayBuffer()) })
      names.push(name)
    }
    await add(inputs, names)
  }
  const pick = async () => { const r = await window.desk.pickAttachments(); if (r.length) setAtts((a) => [...a, ...r]) }

  // files can be dropped anywhere in the window, not just on the box
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const over = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true) } }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false) }
    const drop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); void addFiles([...e.dataTransfer!.files]) }
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop) }
  })

  const submit = () => {
    if ((!text.trim() && !ready.length) || preparing) return
    p.onSend(text.trim(), ready)
    setText(''); setAtts([])
  }

  return (
    <div className="composer-wrap">
      {dragging && <div className="drop-hint">Drop files to attach: images, PDF, Office, text or code</div>}
      <div className={`composer${dragging ? ' dragging' : ''}`}>
        {atts.length > 0 && (
          <div className="att-row">
            {atts.map((a) => (
              <div key={a.id} className={`att-chip${a.error ? ' err' : ''}${a.pending ? ' pending' : ''}`} title={a.error ?? `${a.meta.name}\n${a.meta.info}`}>
                {a.meta.thumb ? <img src={a.meta.thumb} alt="" /> : <span className="att-ico">{a.pending ? '⋯' : a.error ? '⚠' : '📄'}</span>}
                <span className="att-text"><span className="att-name">{a.meta.name}</span><span className="att-info">{a.error ?? a.meta.info}</span></span>
                {!a.pending && <button onClick={() => setAtts(atts.filter((x) => x !== a))} title="Remove">×</button>}
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          placeholder={p.busy ? 'Queue a follow-up: it joins at the agent\'s next step (Enter)' : 'Ask anything, or describe a task…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const f = [...e.clipboardData.files]
            // Office apps put a rendered picture next to copied text; keep that a text paste
            if (!f.length || (e.clipboardData.getData('text/plain').trim() && !f.some((x) => window.desk.pathForFile(x)))) return
            e.preventDefault(); void addFiles(f)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        />
        <div className="composer-bar">
          <button className="clip" onClick={pick} title="Attach files (or paste / drop them). Images are downscaled and documents trimmed to save tokens.">📎</button>
          <select className="model-pick" value={p.model} onChange={(e) => p.onModel(e.target.value)} title={p.model}>
            {(p.models.includes(p.model) ? p.models : [p.model, ...p.models]).map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          <div className="spacer" />
          {p.busy && <button className="send stop" onClick={p.onStop} title="Stop (queued prompts go back in the box)">■</button>}
          {(!p.busy || text.trim() || ready.length > 0) && (
            <button className="send" onClick={submit} disabled={(!text.trim() && !ready.length) || preparing}
              title={preparing ? 'Preparing attachments…' : p.busy ? 'Queue: joins the conversation at the next step' : 'Send'}>↑</button>
          )}
        </div>
      </div>
      <div className="folder">
        <button className="fbtn" onClick={p.onPickFolder} disabled={!p.onPickFolder} title={p.cwd}>
          <span>🗀</span> {folderName(p.cwd)}
        </button>
        <select className="effort-pick" value={p.effort} onChange={(e) => p.onEffort(e.target.value as Effort)} title="Reasoning effort / model thinking for this chat">
          {EFFORTS.map(([v, l]) => <option key={v} value={v}>💭 {l}</option>)}
        </select>
        {p.memories.map((m) => (
          <span key={m} className="mem-chip" title={`Memory: ${m}`}>🧠 {fileName(m)}<button onClick={() => p.onRemoveMemory(m)} title="Detach">×</button></span>
        ))}
        <button className="fbtn" onClick={p.onAddMemory} title="Attach a shared session export as prior memory">＋ Memory</button>
        <div className="spacer" />
        {p.onCompact && <button className="fbtn" onClick={p.onCompact} title="Context size (estimated). Click to compact history: choose which turns to summarize.">⇲ {p.tokens ? `${Math.round(p.tokens / 1000)}k` : ''} Compact</button>}
        {p.onShare && <button className="fbtn" onClick={p.onShare} title="Export this chat to Markdown">⇪ Share</button>}
      </div>
    </div>
  )
}
