import { useCallback, useEffect, useState } from 'react'
import type { UsageBucket, UsageReport } from '../../../shared/usage'

type Tab = 'local' | 'project'
const RANGES = [{ d: 1, l: 'Today' }, { d: 7, l: '7 days' }, { d: 30, l: '30 days' }]

export const fmtTok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
export const fmtUsd = (n: number | null) => n === null ? '—' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Table({ rows, label, requests, onRow }: { rows: UsageBucket[]; label: string; requests: boolean; onRow?(b: UsageBucket): void }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.cost ?? 0), 1e-9)
  return (
    <table className="usage-table">
      <thead><tr><th>{label}</th>{requests && <th>Calls</th>}<th>Input</th><th>Cached</th><th>Output</th><th>Est. cost</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)} title={r.key}>
            <td className="name">{r.label ?? r.key}</td>
            {requests && <td>{r.requests}</td>}
            <td>{fmtTok(r.input + r.cacheWrite)}</td><td>{fmtTok(r.cached)}</td><td>{fmtTok(r.output)}</td>
            <td className="cost"><span className="bar" style={{ width: `${((r.cost ?? 0) / max) * 100}%` }} />{fmtUsd(r.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Days({ rows }: { rows: UsageBucket[] }) {
  if (rows.length < 2) return null
  const max = Math.max(...rows.map((r) => r.cost || r.output), 1e-9)
  return (
    <div className="usage-days">
      {rows.map((r) => (
        <div key={r.key} className="day" title={`${r.key}: ${fmtUsd(r.cost)} · ${fmtTok(r.input + r.cached + r.cacheWrite)} in / ${fmtTok(r.output)} out`}>
          <div className="col" style={{ height: `${Math.max(2, ((r.cost || r.output) / max) * 100)}%` }} />
          <span>{r.key.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

export function UsageModal({ onClose, onOpenChat }: { onClose(): void; onOpenChat(id: string): void }) {
  const [tab, setTab] = useState<Tab>('local')
  const [days, setDays] = useState(7)
  const [rep, setRep] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<{ command: string | null; pricing: string | null } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setRep(tab === 'local' ? await window.desk.getUsage(days) : await window.desk.getProjectUsage(days)) } finally { setLoading(false) }
  }, [tab, days])
  useEffect(() => { setRep(null); void load() }, [load])
  useEffect(() => { void window.desk.usageInfo().then(setInfo) }, [])
  useEffect(() => { if (tab !== 'local') return; return window.desk.onPush((p) => { if (p.type === 'usage') void load() }) }, [tab, load])

  const t = rep?.total
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal usage" onClick={(e) => e.stopPropagation()}>
        <h2>AI usage</h2>
        <div className="usage-bar">
          <div className="seg">
            <button className={tab === 'local' ? 'on' : ''} onClick={() => setTab('local')}>This app</button>
            <button className={tab === 'project' ? 'on' : ''} onClick={() => setTab('project')}>Vertex project</button>
          </div>
          <div className="seg">
            {RANGES.map((r) => <button key={r.d} className={days === r.d ? 'on' : ''} onClick={() => setDays(r.d)}>{r.l}</button>)}
          </div>
          <button className="icon" title="Refresh" onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
        </div>
        <p className="muted small">
          {tab === 'local'
            ? <>Every model call made by this app on this Mac (main agent + sub-agents), recorded as it happens. Cost is a list-price estimate{info?.pricing ? <> from <code>{info.pricing}</code></> : ''}.</>
            : <>Whole GCP project{rep?.project ? <> <code>{rep.project}</code></> : ''} from Cloud Monitoring via <code>{info?.command ?? 'heb-llm-cost'}</code>. Includes every caller, not just you; about 6 weeks of history; Cloud Billing is authoritative.</>}
        </p>
        {loading && !rep && <div className="muted">{tab === 'project' ? 'Querying Cloud Monitoring…' : 'Loading…'}</div>}
        {rep?.error && <pre className="err">{rep.error}</pre>}
        {rep && !rep.error && t && (
          <>
            <div className="usage-cards">
              <div><b>{fmtUsd(t.cost)}</b><span>Est. cost</span></div>
              {tab === 'local' && <div><b>{t.requests.toLocaleString()}</b><span>Model calls</span></div>}
              <div><b>{fmtTok(t.input + t.cached + t.cacheWrite)}</b><span>Input tokens</span></div>
              <div><b>{t.input + t.cached + t.cacheWrite ? `${Math.round((t.cached / (t.input + t.cached + t.cacheWrite)) * 100)}%` : '—'}</b><span>Cache hit</span></div>
              <div><b>{fmtTok(t.output)}</b><span>Output tokens</span></div>
            </div>
            {!t.requests && !t.output && !t.input && <div className="muted">No usage in this range yet.</div>}
            <Days rows={rep.byDay} />
            <h4>By model</h4>
            <Table rows={rep.byModel} label="Model" requests={tab === 'local'} />
            {rep.byChat && rep.byChat.length > 0 && <><h4>By chat</h4><Table rows={rep.byChat.slice(0, 25)} label="Chat" requests onRow={(b) => { if (b.label !== '(deleted chat)') { onOpenChat(b.key); onClose() } }} /></>}
            {rep.warnings.length > 0 && <ul className="usage-warn">{rep.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {rep.pricingAsOf && <div className="muted small">Prices as of {rep.pricingAsOf}.</div>}
          </>
        )}
        <div className="actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}

/** Small progress ring: today's spend vs daily budget (or a plain ring with no budget). */
export function UsageRing({ frac }: { frac: number | null }) {
  const r = 7, c = 2 * Math.PI * r, f = Math.min(1, Math.max(0, frac ?? 0))
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className={`usage-ring${(frac ?? 0) >= 1 ? ' over' : (frac ?? 0) >= 0.8 ? ' warn' : ''}`}>
      <circle cx="9" cy="9" r={r} className="track" />
      {frac !== null && <circle cx="9" cy="9" r={r} className="fill" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 9 9)" />}
    </svg>
  )
}
