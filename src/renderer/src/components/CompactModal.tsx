import { useEffect, useMemo, useState } from 'react'
import type { SessionRow, TurnAnalysis } from '../../../shared/api'

interface Props {
  session: SessionRow
  keepRecentDefault: number
  onClose(): void
  onDone(msg: string): void
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const oneLine = (s: string, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

export function CompactModal({ session, keepRecentDefault, onClose, onDone }: Props) {
  const [a, setA] = useState<TurnAnalysis | null>(null)
  const [err, setErr] = useState('')
  const [keep, setKeep] = useState(keepRecentDefault)
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [view, setView] = useState<'clusters' | 'turns'>('clusters')
  const [openC, setOpenC] = useState<Set<number>>(new Set())
  const [working, setWorking] = useState(false)

  useEffect(() => {
    window.desk.analyzeTurns(session.id)
      .then((r) => { setA(r); setPick(new Set(r.turns.map((t) => t.index))) })
      .catch((e) => setErr(String(e.message ?? e)))
  }, [session.id])

  const n = a?.turns.length ?? 0
  const cut = Math.max(0, n - keep)
  const older = useMemo(() => (a ? a.turns.filter((t) => t.index < cut) : []), [a, cut])
  const recent = useMemo(() => (a ? a.turns.filter((t) => t.index >= cut) : []), [a, cut])
  const chosen = older.filter((t) => pick.has(t.index))
  const dropped = older.filter((t) => !pick.has(t.index))
  const tok = (ts: typeof older) => ts.reduce((s, t) => s + t.tokens, 0)
  const label = (i: number) => (a ? i + a.uiOffset + 1 : i + 1)

  const setMany = (idx: number[], on: boolean) => setPick((p) => { const s = new Set(p); idx.forEach((i) => (on ? s.add(i) : s.delete(i))); return s })
  const toggleOpen = (i: number) => setOpenC((p) => { const s = new Set(p); s.has(i) ? s.delete(i) : s.add(i); return s })

  const go = async () => {
    setWorking(true); setErr('')
    try {
      const r = await window.desk.compact(session.id, { summarize: chosen.map((t) => t.index), keepRecent: keep })
      onDone(`Compacted ${r.summarized} turn(s) into a summary${r.dropped ? `, dropped ${r.dropped}` : ''}: ~${k(r.before)} → ~${k(r.after)} tokens`)
    } catch (e: any) { setErr(String(e.message ?? e)); setWorking(false) }
  }

  const turnRow = (t: TurnAnalysis['turns'][number], inRecent = false) => (
    <label key={t.index} className={`turn-row ${inRecent ? 'recent' : ''}`} title={`${t.user}\n\n→ ${t.answer}`}>
      <input type="checkbox" disabled={inRecent} checked={inRecent || pick.has(t.index)} onChange={(e) => setMany([t.index], e.target.checked)} />
      <span className="turn-no">{label(t.index)}</span>
      <span className="turn-text">{oneLine(t.user)}{t.answer && <span className="muted"> → {oneLine(t.answer, 80)}</span>}</span>
      <span className="turn-tok">{inRecent ? 'kept' : `~${k(t.tokens)}`}</span>
    </label>
  )

  return (
    <div className="modal-bg" onClick={working ? undefined : onClose}>
      <div className="modal share compact" onClick={(e) => e.stopPropagation()}>
        <h2>Compact history</h2>
        <p className="muted">
          Pick which earlier turns to fold into a summary the agent keeps as memory. Unticked turns are <b>dropped</b> from the model's context (they stay visible here in the chat). The most recent turns stay word-for-word.
        </p>
        {err && <div className="err">{err}</div>}
        {!a && !err && <div className="working"><span className="spinner" /> Finding related turns…</div>}
        {a && (
          <>
            <div className="compact-top">
              <span>Context now <b>~{k(a.tokens)}</b> tokens · {n} turn(s){a.hasPriorSummary && ' + earlier summary'}</span>
              <label className="keep">Keep last
                <input type="number" min={0} max={n} value={keep} onChange={(e) => setKeep(Math.max(0, Math.min(n, Number(e.target.value))))} /> turn(s) verbatim
              </label>
            </div>
            {older.length === 0 ? <p className="muted">Nothing to compact: every turn is inside the "keep last" window.</p> : (
              <>
                <div className="turn-pick-bar plain">
                  <div className="seg small">
                    <button className={view === 'clusters' ? 'on' : ''} onClick={() => setView('clusters')}>Related turns ({a.method === 'model' ? 'AI' : 'keywords'})</button>
                    <button className={view === 'turns' ? 'on' : ''} onClick={() => setView('turns')}>All turns</button>
                  </div>
                  <button onClick={() => setMany(older.map((t) => t.index), true)}>Select all</button>
                  <button onClick={() => setMany(older.map((t) => t.index), false)}>Clear</button>
                </div>
                <div className="turn-pick tall">
                  {view === 'turns' ? older.map((t) => turnRow(t)) : a.clusters.map((c, ci) => {
                    const ts = older.filter((t) => c.turns.includes(t.index))
                    if (!ts.length) return null
                    const on = ts.filter((t) => pick.has(t.index)).length
                    const expanded = openC.has(ci)
                    return (
                      <div key={ci} className="cluster">
                        <div className="cluster-head">
                          <input type="checkbox" checked={on === ts.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < ts.length }}
                            onChange={(e) => setMany(ts.map((t) => t.index), e.target.checked)} />
                          <button className="cluster-title" onClick={() => toggleOpen(ci)}>
                            <span className="chev">{expanded ? '▾' : '▸'}</span>
                            <b>{c.label}</b>
                            <span className="muted"> · turns {ts.map((t) => label(t.index)).join(', ')}</span>
                          </button>
                          <span className="turn-tok">~{k(tok(ts))}</span>
                        </div>
                        {c.reason && <div className="cluster-reason muted">{c.reason}</div>}
                        {expanded && <div className="cluster-turns">{ts.map((t) => turnRow(t))}</div>}
                      </div>
                    )
                  })}
                  {recent.length > 0 && <div className="recent-head muted">Kept verbatim</div>}
                  {recent.map((t) => turnRow(t, true))}
                </div>
                <div className="compact-sum">
                  Summarize <b>{chosen.length}</b> turn(s) (~{k(tok(chosen))}) · drop <b>{dropped.length}</b> (~{k(tok(dropped))}) · keep <b>{recent.length}</b> verbatim
                </div>
              </>
            )}
          </>
        )}
        <div className="actions">
          <button onClick={onClose} disabled={working}>Cancel</button>
          <button className="primary" onClick={go} disabled={!a || working || older.length === 0}>{working ? 'Compacting…' : 'Compact'}</button>
        </div>
      </div>
    </div>
  )
}
