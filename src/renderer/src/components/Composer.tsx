import { useEffect, useRef, useState } from 'react'

interface Props {
  busy: boolean
  model: string
  models: string[]
  cwd: string
  onModel(m: string): void
  onPickFolder?: () => void
  onSend(text: string): void
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

  const submit = () => {
    if (!text.trim() || p.busy) return
    p.onSend(text.trim())
    setText('')
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ta}
          rows={1}
          placeholder="Ask anything, or describe a task…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        />
        <div className="composer-bar">
          <select className="model-pick" value={p.model} onChange={(e) => p.onModel(e.target.value)} title={p.model}>
            {(p.models.includes(p.model) ? p.models : [p.model, ...p.models]).map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          <div className="spacer" />
          {p.busy
            ? <button className="send stop" onClick={p.onStop} title="Stop">■</button>
            : <button className="send" onClick={submit} disabled={!text.trim()} title="Send">↑</button>}
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
