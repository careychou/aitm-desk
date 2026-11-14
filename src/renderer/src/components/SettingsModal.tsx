import { useEffect, useState } from 'react'
import type { ModelGroup, RegistryInfo, Settings } from '../../../shared/api'
import { bareModel } from '../../../shared/providers'
import { ProvidersTab } from './ProvidersTab'

type Tab = 'providers' | 'general' | 'compaction' | 'skills'

export function SettingsModal({ cwd, onClose }: { cwd: string; onClose(): void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [reg, setReg] = useState<RegistryInfo | null>(null)
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [health, setHealth] = useState('')
  const [tab, setTab] = useState<Tab>('providers')
  useEffect(() => {
    void window.desk.getSettings().then(setS); void window.desk.registryInfo(cwd).then(setReg)
    void window.desk.listModels().then((r) => setGroups(r.groups ?? []))
  }, [cwd])
  if (!s) return null
  const set = (k: keyof Settings, v: string | number) => setS({ ...s, [k]: v })
  const testAll = async () => {
    await window.desk.saveSettings(s)
    const r = await window.desk.listModels()
    setGroups(r.groups ?? [])
    setHealth(r.error ? `✗ ${r.error}` : `✓ ${r.models.length} models from ${r.groups.filter((g) => !g.error).length} provider(s)`)
  }
  const tabs: Array<[Tab, string]> = [['providers', 'Model providers'], ['general', 'General'], ['compaction', 'Memory compaction'], ['skills', 'Skills & agents']]
  const compactKnown = !s.compactModel || groups.some((g) => g.models.includes(s.compactModel))
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="tabs">
          {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {tab === 'providers' && <ProvidersTab s={s} setS={setS} />}
        {tab === 'general' && (
          <div className="form">
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
            <div className="sub-h">AI usage (⌘⇧U)</div>
            <div className="row3">
              <label>Daily budget (USD, 0 = off)<input type="number" min={0} step={5} value={s.dailyBudget} onChange={(e) => set('dailyBudget', Number(e.target.value))} title="Fills the usage ring in the sidebar against today's estimated spend." /></label>
              <label>pricing.json<input value={s.pricingPath} placeholder="auto: ~/.aitm-desk or ~/heb-model-proxy" onChange={(e) => set('pricingPath', e.target.value)} /></label>
              <label>Project usage command<input value={s.usageCommand} placeholder="auto: heb-llm-cost" onChange={(e) => set('usageCommand', e.target.value)} title="Must accept --days N --by model,day --json (heb-llm-cost contract)." /></label>
            </div>
            <div className="row3">
              <label>Max concurrent model calls<input type="number" min={1} max={16} value={s.maxConcurrency} onChange={(e) => set('maxConcurrency', Number(e.target.value))} /></label>
              <label>Max turns (main)<input type="number" min={1} value={s.maxTurnsMain} onChange={(e) => set('maxTurnsMain', Number(e.target.value))} /></label>
              <label>Max turns (sub-agent)<input type="number" min={1} value={s.maxTurnsSub} onChange={(e) => set('maxTurnsSub', Number(e.target.value))} /></label>
            </div>
          </div>
        )}
        {tab === 'compaction' && (
          <div className="form">
            <div className="muted small">Compaction folds older turns into a summary so long chats stay fast and cheap. It rewrites the start of the conversation, so the provider's prompt cache (Claude: ~5 min) is rebuilt once on the next call. It pays off when you keep using the chat, so the defaults wait until the cache has gone cold anyway, unless the chat is very large.</div>
            <label>Compaction model (summaries and topic grouping)
              <select value={s.compactModel} onChange={(e) => set('compactModel', e.target.value)}>
                <option value="">Same as the chat's model</option>
                {!compactKnown && <option value={s.compactModel}>{s.compactModel} (not listed)</option>}
                {groups.map((g) => (
                  <optgroup key={g.provider} label={g.name}>{g.models.map((m) => <option key={m} value={m}>{bareModel(m)}</option>)}</optgroup>
                ))}
              </select>
              <span className="muted small">A fast, cheaper model is usually enough to summarize. If it fails, the chat's model is used instead.</span>
            </label>
            <div className="row3">
              <label>Long chats
                <select value={s.autoCompact} onChange={(e) => set('autoCompact', e.target.value)}>
                  <option value="off">Do nothing</option>
                  <option value="suggest">Suggest compacting</option>
                  <option value="auto">Auto-compact (cache-aware)</option>
                </select>
              </label>
              <label>Threshold (tokens)<input type="number" min={5000} step={5000} value={s.compactThreshold} onChange={(e) => set('compactThreshold', Number(e.target.value))} title="Chats above this size are candidates for compaction." /></label>
              <label>Keep last N turns verbatim<input type="number" min={0} max={20} value={s.compactKeepRecent} onChange={(e) => set('compactKeepRecent', Number(e.target.value))} /></label>
            </div>
            <div className="sub-h">Auto-compact rules (when Long chats = Auto)</div>
            <div className="row3">
              <label>Wait until idle (minutes)<input type="number" min={0} max={240} value={s.compactIdleMinutes} onChange={(e) => set('compactIdleMinutes', Number(e.target.value))} title="Only compact when the chat's last model call is at least this old, so the prompt cache has already expired. 0 = compact immediately." /></label>
              <label>Compact anyway above (tokens)<input type="number" min={0} step={10000} value={s.compactHardLimit} onChange={(e) => set('compactHardLimit', Number(e.target.value))} title="Above this size, compact even if the cache is warm. 0 = never override the idle wait." /></label>
              <label>Minimum saving (tokens)<input type="number" min={0} step={5000} value={s.compactMinGain} onChange={(e) => set('compactMinGain', Number(e.target.value))} title="Skip if the turns that would be summarized are smaller than this; small compactions cost more in cache writes than they save." /></label>
            </div>
            <div className="muted small">Rule: compact when the chat is over the threshold <b>and</b> at least the minimum saving would be summarized <b>and</b> (it has been idle for the wait time <b>or</b> it is over the hard limit).</div>
          </div>
        )}
        {tab === 'skills' && (
          <div className="reg">
            <div className="muted">Loaded from <code>{cwd}/.github</code> and <code>~/.copilot</code></div>
            <h4>Agents ({reg?.agents.length ?? 0})</h4>
            <ul>{reg?.agents.map((a) => <li key={a.name}><b>{a.name}</b> <span className="tag">{a.source}</span><div className="muted">{a.description.slice(0, 160)}</div></li>)}</ul>
            <h4>Skills ({reg?.skills.length ?? 0})</h4>
            <ul>{reg?.skills.map((a) => <li key={a.name}><b>{a.name}</b> <span className="tag">{a.source}</span><div className="muted">{a.description.slice(0, 160)}</div></li>)}</ul>
            {reg?.warnings.length ? <><h4>Warnings</h4><ul>{reg.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></> : null}
          </div>
        )}
        {tab !== 'skills' && (
          <div className="row-actions modal-foot">
            <button onClick={testAll}>Test connection</button>
            <span className="muted small">{health}</span>
            <div className="spacer" />
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={async () => { await window.desk.saveSettings(s); onClose() }}>Save</button>
          </div>
        )}
      </div>
    </div>
  )
}
