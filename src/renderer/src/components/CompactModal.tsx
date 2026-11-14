import { useEffect, useMemo, useState } from 'react'
import type { SessionRow, TurnAnalysis } from '../../../shared/api'

interface Props {
  session: SessionRow
  keepRecentDefault: number
  onClose(): void
  onDone(msg: string): void
}

type Act = 'keep' | 'summarize' | 'drop'
type Turn = TurnAnalysis['turns'][number]

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const oneLine = (s: string, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const ACTS: Array<[Act, string, string]> = [
  ['keep', 'Keep', 'Keep this turn word-for-word'],
  ['summarize', 'Summarize', 'Fold into the summary'],
  ['drop', 'Drop', 'Remove from the agent\'s context']
]

/** Three-way Keep / Summarize / Drop pill; `mixed` when a group's turns disagree. */
function ActPill({ value, onChange, small }: { value: Act | 'mixed'; onChange(a: Act): void; small?: boolean }) {
  return (
    <span className={`act-pill ${small ? 'small' : ''}`} onClick={(e) => e.stopPropagation()}>
      {ACTS.map(([a, label, tip]) => (
        <button key={a} className={`${a} ${value === a ? 'on' : ''}`} title={tip} onClick={() => onChange(a)}>{label}</button>
      ))}
    </span>
  )
}

export function CompactModal({ session, keepRecentDefault, onClose, onDone }: Props) {
  const [a, setA] = useState<TurnAnalysis | null>(null)
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'last' | 'choose'>('last')
  const [keepN, setKeepN] = useState(keepRecentDefault)
  const [acts, setActs] = useState<Act[]>([])
  const [view, setView] = useState<'clusters' | 'turns'>('clusters')
  const [openC, setOpenC] = useState<Set<number>>(new Set())
  const [working, setWorking] = useState(false)

  useEffect(() => {
    window.desk.analyzeTurns(session.id)
      .then((r) => { setA(r); setKeepN((v) => Math.min(v, Math.max(0, r.turns.length - 1))) })
      .catch((e) => setErr(String(e.message ?? e)))
  }, [session.id])

  const n = a?.turns.length ?? 0
  const lastActs = (keep: number): Act[] => Array.from({ length: n }, (_, i) => (i >= n - keep ? 'keep' : 'summarize'))
  // Choose mode starts from whatever "keep last N" currently means, so switching never surprises.
  const switchMode = (m: 'last' | 'choose') => { if (m === 'choose') setActs(lastActs(keepN)); setMode(m) }
  const eff: Act[] = mode === 'last' ? lastActs(keepN) : acts
  const set = (idx: number[], act: Act) => setActs((p) => { const x = [...p]; idx.forEach((i) => { x[i] = act }); return x })
  const groupAct = (idx: number[]): Act | 'mixed' => { const s = new Set(idx.map((i) => eff[i])); return s.size === 1 ? [...s][0] : 'mixed' }
  const label = (i: number) => (a ? (a.uiTurns[i] ?? i) + 1 : i + 1)

  const by = useMemo(() => {
    const out: Record<Act, Turn[]> = { keep: [], summarize: [], drop: [] }
    a?.turns.forEach((t) => out[eff[t.index] ?? 'summarize'].push(t))
    return out
  }, [a, eff])
  const tok = (ts: Turn[]) => ts.reduce((s, t) => s + t.tokens, 0)
  const nothing = !by.summarize.length && !by.drop.length

  const go = async () => {
    setWorking(true); setErr('')
    try {
      const r = await window.desk.compact(session.id, { keep: by.keep.map((t) => t.index), summarize: by.summarize.map((t) => t.index) })
      onDone(`Compacted: ${r.summarized} summarized${r.dropped ? `, ${r.dropped} dropped` : ''}, ${by.keep.length} kept · ~${k(r.before)} → ~${k(r.after)} tokens`)
    } catch (e: any) { setErr(String(e.message ?? e)); setWorking(false) }
  }

  const turnRow = (t: Turn) => (
    <div key={t.index} className={`turn-row act-${eff[t.index]}`} title={`${t.user}\n\n→ ${t.answer}`}>
      <span className="turn-no">{label(t.index)}</span>
      <span className="turn-text">{oneLine(t.user)}{t.answer && <span className="muted"> → {oneLine(t.answer, 80)}</span>}</span>
      <span className="turn-tok">~{k(t.tokens)}</span>
      <ActPill small value={eff[t.index]} onChange={(x) => set([t.index], x)} />
    </div>
  )

  return (
    <div className="modal-bg" onClick={working ? undefined : onClose}>
      <div className="modal share compact" onClick={(e) => e.stopPropagation()}>
        <h2>Compact history</h2>
        <p className="muted">Shrink what the agent carries forward. The chat view keeps every turn either way.</p>
        {err && <div className="err">{err}</div>}
        {!a && !err && <div className="working"><span className="spinner" /> Reading turns and finding related ones…</div>}
        {a && (
          <>
            <div className="compact-top">
              <span>Context now <b>~{k(a.tokens)}</b> tokens · {n} turn(s){a.hasPriorSummary && ' + earlier summary'}</span>
            </div>

            <div className="mode-pick">
              <label className={mode === 'last' ? 'on' : ''}>
                <input type="radio" checked={mode === 'last'} onChange={() => switchMode('last')} />
                <span>
                  <b>Keep the last</b>{' '}
                  <input type="number" className="n" min={0} max={n} value={keepN} disabled={mode !== 'last'}
                    onChange={(e) => setKeepN(Math.max(0, Math.min(n, Number(e.target.value))))} />{' '}
                  turn(s) word-for-word, summarize everything before
                </span>
              </label>
              <label className={mode === 'choose' ? 'on' : ''}>
                <input type="radio" checked={mode === 'choose'} onChange={() => switchMode('choose')} />
                <span><b>Choose turns</b>: pick Keep, Summarize or Drop for each turn or each group of related turns</span>
              </label>
            </div>

            {mode === 'choose' && (
              <>
                <div className="turn-pick-bar plain">
                  <div className="seg small">
                    <button className={view === 'clusters' ? 'on' : ''} onClick={() => setView('clusters')}>Related turns ({a.method === 'model' ? `AI · ${a.model.split('::').pop()!.split('/').pop()}` : 'keywords'})</button>
                    <button className={view === 'turns' ? 'on' : ''} onClick={() => setView('turns')}>All turns</button>
                  </div>
                  <span className="muted small-label">Set all:</span>
                  <ActPill small value={groupAct(a.turns.map((t) => t.index))} onChange={(x) => set(a.turns.map((t) => t.index), x)} />
                </div>
                <div className="turn-pick tall">
                  {view === 'turns' ? a.turns.map(turnRow) : a.clusters.map((c, ci) => {
                    const ts = a.turns.filter((t) => c.turns.includes(t.index))
                    if (!ts.length) return null
                    const idx = ts.map((t) => t.index)
                    const expanded = openC.has(ci)
                    const ga = groupAct(idx)
                    return (
                      <div key={ci} className={`cluster act-${ga}`}>
                        <div className="cluster-head">
                          <button className="cluster-title" onClick={() => setOpenC((p) => { const s = new Set(p); s.has(ci) ? s.delete(ci) : s.add(ci); return s })}>
                            <span className="chev">{expanded ? '▾' : '▸'}</span>
                            <b>{c.label}</b>
                            <span className="muted"> · {ts.length > 1 ? 'turns' : 'turn'} {ts.map((t) => label(t.index)).join(', ')}</span>
                          </button>
                          <span className="turn-tok">~{k(tok(ts))}</span>
                          <ActPill small value={ga} onChange={(x) => set(idx, x)} />
                        </div>
                        {c.reason && <div className="cluster-reason muted">{c.reason}</div>}
                        {expanded && <div className="cluster-turns">{ts.map(turnRow)}</div>}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            <div className="compact-sum">
              <span className="dot keep" /> Keep <b>{by.keep.length}</b> <span className="muted">(~{k(tok(by.keep))})</span>
              <span className="dot summarize" /> Summarize <b>{by.summarize.length}</b> <span className="muted">(~{k(tok(by.summarize))})</span>
              <span className="dot drop" /> Drop <b>{by.drop.length}</b> <span className="muted">(~{k(tok(by.drop))})</span>
            </div>
            {nothing && <p className="muted hint">Nothing to compact: every turn is set to Keep.{mode === 'last' && n > 0 ? ' Lower the number, or choose turns.' : ''}</p>}
          </>
        )}
        <div className="actions">
          <button onClick={onClose} disabled={working}>Cancel</button>
          <button className="primary" onClick={go} disabled={!a || working || nothing}>{working ? 'Compacting…' : 'Compact'}</button>
        </div>
      </div>
    </div>
  )
}
