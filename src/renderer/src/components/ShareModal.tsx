import { useEffect, useMemo, useState } from 'react'
import type { SessionRow } from '../../../shared/api'
import { exportMarkdown, splitTurns, type ExportItem } from '../../../shared/export'
import { BRAND } from '../../../shared/brand'

interface Props {
  session: SessionRow
  onClose(): void
}

export function ShareModal({ session, onClose }: Props) {
  const [items, setItems] = useState<ExportItem[] | null>(null)
  const [all, setAll] = useState(true)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tools, setTools] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { void window.desk.loadItems(session.id).then((x) => setItems(x as ExportItem[])) }, [session.id])
  const turns = useMemo(() => (items ? splitTurns(items) : []), [items])
  useEffect(() => { setPicked(new Set(turns.map((_, i) => i))) }, [turns])

  const selected = all ? turns.map((_, i) => i) : [...picked]
  const md = () => exportMarkdown(items ?? [], { title: session.title, cwd: session.cwd, model: session.model, turns: all ? undefined : selected, includeTools: tools, includeThinking: thinking })
  const toggle = (i: number) => setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n })

  const save = async () => { const p = await window.desk.saveExport(session.title, md()); if (p) setSaved(p) }
  const copy = async () => { await window.desk.copyText(md()); setCopied(true); setTimeout(() => setCopied(false), 1500) }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal share" onClick={(e) => e.stopPropagation()}>
        <h2>Share session</h2>
        <p className="muted">Exports to a Markdown file. Anyone can read it, and any {BRAND.name} chat can attach it as <b>memory</b>.</p>
        <div className="seg">
          <button className={all ? 'on' : ''} onClick={() => setAll(true)}>All turns ({turns.length})</button>
          <button className={!all ? 'on' : ''} onClick={() => setAll(false)}>Select turns</button>
        </div>
        {!all && (
          <div className="turn-pick">
            <div className="turn-pick-bar">
              <button onClick={() => setPicked(new Set(turns.map((_, i) => i)))}>Select all</button>
              <button onClick={() => setPicked(new Set())}>Clear</button>
              <span className="muted">{picked.size} selected</span>
            </div>
            {turns.map((t, i) => (
              <label key={i} className="turn-row">
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <span className="turn-no">{i + 1}</span>
                <span className="turn-text">{(t[0] as { text: string }).text.replace(/\s+/g, ' ')}</span>
              </label>
            ))}
          </div>
        )}
        <div className="opts">
          <label><input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> Include tool calls &amp; outputs</label>
          <label><input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Include model thinking</label>
        </div>
        {saved && <div className="saved">Saved <code>{saved}</code> <button className="link" onClick={() => window.desk.revealFile(saved)}>Show in Finder</button></div>}
        <div className="actions">
          <button onClick={onClose}>Close</button>
          <button onClick={copy} disabled={!items || !selected.length}>{copied ? 'Copied ✓' : 'Copy Markdown'}</button>
          <button className="primary" onClick={save} disabled={!items || !selected.length}>Save .md…</button>
        </div>
      </div>
    </div>
  )
}
