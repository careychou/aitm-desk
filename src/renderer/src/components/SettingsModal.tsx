import { useEffect, useState } from 'react'
import type { RegistryInfo, Settings } from '../../../shared/api'

export function SettingsModal({ cwd, onClose }: { cwd: string; onClose(): void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [reg, setReg] = useState<RegistryInfo | null>(null)
  const [health, setHealth] = useState('')
  const [tab, setTab] = useState<'model' | 'skills'>('model')
  useEffect(() => { void window.desk.getSettings().then(setS); void window.desk.registryInfo(cwd).then(setReg) }, [cwd])
  if (!s) return null
  const set = (k: keyof Settings, v: string | number) => setS({ ...s, [k]: v })
  const test = async () => {
    await window.desk.saveSettings(s)
    const r = await window.desk.listModels()
    setHealth(r.error ? `✗ ${r.error}` : `✓ ${r.models.length} models available`)
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="tabs">
          <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>Model provider</button>
          <button className={tab === 'skills' ? 'on' : ''} onClick={() => setTab('skills')}>Skills & agents</button>
        </div>
        {tab === 'model' ? (
          <div className="form">
            <label>Base URL (OpenAI-compatible)<input value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} /></label>
            <label>API key<input type="password" value={s.apiKey} onChange={(e) => set('apiKey', e.target.value)} /></label>
            <label>Default thinking for new chats (each chat can override it below its chat box)
              <select value={s.reasoning} onChange={(e) => set('reasoning', e.target.value)}>
                <option value="off">Off — no thinking block</option>
                <option value="low">Low</option>
                <option value="medium">Medium (default)</option>
                <option value="high">High — deeper, slower</option>
              </select>
            </label>
            <label>Default mode for new chats (each chat can switch below its chat box)
              <select value={s.defaultMode} onChange={(e) => set('defaultMode', e.target.value)}>
                <option value="autopilot">Autopilot — run shell, file and web tools without asking</option>
                <option value="interactive">Interactive — ask before shell, file writes and web fetches</option>
              </select>
            </label>
            <div className="row3">
              <label>Long chats
                <select value={s.autoCompact} onChange={(e) => set('autoCompact', e.target.value)}>
                  <option value="off">Do nothing</option>
                  <option value="suggest">Suggest compacting</option>
                  <option value="auto">Auto-compact all turns</option>
                </select>
              </label>
              <label>Threshold (tokens)<input type="number" min={5000} step={5000} value={s.compactThreshold} onChange={(e) => set('compactThreshold', Number(e.target.value))} /></label>
              <label>Keep last N turns verbatim<input type="number" min={0} max={20} value={s.compactKeepRecent} onChange={(e) => set('compactKeepRecent', Number(e.target.value))} /></label>
            </div>
            <div className="sub-h">Attachments: compress to save tokens and stay under the provider's request limit</div>
            <div className="row3">
              <label>Image max edge (px)<input type="number" min={256} max={4096} step={64} value={s.imageMaxEdge} onChange={(e) => set('imageMaxEdge', Number(e.target.value))} /></label>
              <label>JPEG quality<input type="number" min={40} max={100} value={s.imageQuality} onChange={(e) => set('imageQuality', Number(e.target.value))} /></label>
              <label>Max per image (KB)<input type="number" min={100} step={100} value={s.imageMaxKB} onChange={(e) => set('imageMaxKB', Number(e.target.value))} /></label>
            </div>
            <div className="row3">
              <label>Max document chars<input type="number" min={2000} step={10000} value={s.docMaxChars} onChange={(e) => set('docMaxChars', Number(e.target.value))} /></label>
              <label>Re-send images from last N prompts<input type="number" min={0} max={50} value={s.imageTurns} onChange={(e) => set('imageTurns', Number(e.target.value))} title="Older images are replaced by a short note. 0 = always re-send all." /></label>
              <label>Max request size (MB)<input type="number" min={1} max={100} value={s.requestMaxMB} onChange={(e) => set('requestMaxMB', Number(e.target.value))} title="Oldest images are dropped first if a request would exceed this. Vertex rejects > 30 MB." /></label>
            </div>
            <div className="row3">
              <label>Max concurrent model calls<input type="number" min={1} max={16} value={s.maxConcurrency} onChange={(e) => set('maxConcurrency', Number(e.target.value))} /></label>
              <label>Max turns (main)<input type="number" min={1} value={s.maxTurnsMain} onChange={(e) => set('maxTurnsMain', Number(e.target.value))} /></label>
              <label>Max turns (sub-agent)<input type="number" min={1} value={s.maxTurnsSub} onChange={(e) => set('maxTurnsSub', Number(e.target.value))} /></label>
            </div>
            <div className="row-actions">
              <button onClick={test}>Test connection</button>
              <span className="muted">{health}</span>
              <div className="spacer" />
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={async () => { await window.desk.saveSettings(s); onClose() }}>Save</button>
            </div>
          </div>
        ) : (
          <div className="reg">
            <div className="muted">Loaded from <code>{cwd}/.github</code> and <code>~/.copilot</code></div>
            <h4>Agents ({reg?.agents.length ?? 0})</h4>
            <ul>{reg?.agents.map((a) => <li key={a.name}><b>{a.name}</b> <span className="tag">{a.source}</span><div className="muted">{a.description.slice(0, 160)}</div></li>)}</ul>
            <h4>Skills ({reg?.skills.length ?? 0})</h4>
            <ul>{reg?.skills.map((a) => <li key={a.name}><b>{a.name}</b> <span className="tag">{a.source}</span><div className="muted">{a.description.slice(0, 160)}</div></li>)}</ul>
            {reg?.warnings.length ? <><h4>Warnings</h4><ul>{reg.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></> : null}
          </div>
        )}
      </div>
    </div>
  )
}
