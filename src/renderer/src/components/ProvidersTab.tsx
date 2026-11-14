import { useState } from 'react'
import type { ProviderEntry, Settings } from '../../../shared/api'
import { parseVertexModels, providerId } from '../../../shared/providers'
import { BRAND } from '../../../shared/brand'

const KINDS: Array<{ kind: ProviderEntry['kind']; icon: string; name: string; desc: string }> = [
  { kind: 'openai', icon: '⌁', name: 'Custom endpoint', desc: 'Any OpenAI-compatible HTTP endpoint (local model proxy, vLLM, OpenRouter, LiteLLM, fine-tunes).' },
  { kind: 'azure', icon: '◭', name: 'Azure OpenAI', desc: 'Deployments on your Azure resource host, with an API version and per-model deployment names.' },
  { kind: 'vertex', icon: '◈', name: 'Google Vertex AI', desc: 'Gemini, Claude and Model Garden MaaS models straight from your GCP project, signed in with a service-account key. No local proxy.' }
]
const KIND_NAME: Record<ProviderEntry['kind'], string> = { openai: 'Custom endpoint', azure: 'Azure OpenAI', vertex: 'Google Vertex AI' }
const KIND_ICON: Record<ProviderEntry['kind'], string> = { openai: '⌁', azure: '◭', vertex: '◈' }

async function blank(kind: ProviderEntry['kind'], taken: string[]): Promise<ProviderEntry> {
  if (kind === 'azure') return { id: providerId('azure', taken), name: 'Azure OpenAI', kind, baseUrl: '', apiKey: '', apiVersion: '2025-04-01-preview', deployments: [], enabled: true }
  if (kind === 'vertex') {
    const d = await window.desk.vertexDefaults().catch(() => null)
    return { id: providerId('vertex', taken), name: BRAND.vertexProviderName, kind, baseUrl: '', apiKey: '', project: d?.project ?? '', location: d?.location || 'global', credentialsPath: d?.credentialsPath ?? '', models: d?.models ?? [], visionModel: d?.visionModel ?? '', cacheTtl: '5m', enabled: true }
  }
  return { id: providerId('custom', taken), name: 'Custom endpoint', kind, baseUrl: 'http://127.0.0.1:4141/v1', apiKey: '', enabled: true }
}

const summary = (p: ProviderEntry) => (p.kind === 'vertex' ? (p.project ? `${p.project} · ${p.location || 'global'}` : 'project not set') : p.baseUrl || 'not set')

/** Settings → Model providers: list, add (Custom / Azure), edit, test, the first provider is the primary. */
export function ProvidersTab({ s, setS }: { s: Settings; setS(s: Settings): void }) {
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(s.providers.length === 1 ? s.providers[0].id : null)
  const [status, setStatus] = useState<Record<string, string>>({})
  const list = s.providers
  const put = (next: ProviderEntry[]) => setS({ ...s, providers: next })
  const upd = (id: string, patch: Partial<ProviderEntry>) => put(list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const add = async (kind: ProviderEntry['kind']) => { const p = await blank(kind, list.map((x) => x.id)); put([...list, p]); setOpen(p.id); setAdding(false) }
  const pickKey = async (p: ProviderEntry) => { const f = await window.desk.pickFile({ title: 'Service-account key (JSON)', extensions: ['json'] }); if (f) upd(p.id, { credentialsPath: f }) }
  const importProxy = async (p: ProviderEntry) => {
    const d = await window.desk.vertexDefaults()
    if (!d.models.length) { setStatus((x) => ({ ...x, [p.id]: '✗ no ~/heb-model-proxy/models.json found' })); return }
    upd(p.id, { project: p.project || d.project, location: p.location || d.location, credentialsPath: p.credentialsPath || d.credentialsPath, models: d.models, visionModel: p.visionModel || d.visionModel })
    setStatus((x) => ({ ...x, [p.id]: `Imported ${d.models.length} models from the local model proxy` }))
  }
  const remove = (id: string) => { if (confirm('Remove this provider? Chats using its models will fail until you pick another model.')) put(list.filter((p) => p.id !== id)) }
  const test = async (p: ProviderEntry) => {
    setStatus((x) => ({ ...x, [p.id]: 'Testing…' }))
    const r = await window.desk.testProvider(p)
    setStatus((x) => ({ ...x, [p.id]: r.error ? `✗ ${r.error}` : `✓ ${r.models.length} model${r.models.length === 1 ? '' : 's'}: ${r.models.slice(0, 6).map((m) => m.split('/').pop()).join(', ')}${r.models.length > 6 ? '…' : ''}` }))
  }

  return (
    <div className="form providers">
      <div className="prov-head">
        <div>
          <b>Configured providers</b>
          <div className="muted small">Your keys stay on this Mac (encrypted with the macOS keychain) and go straight to the provider. The first provider is the primary: its models appear unprefixed and existing chats are tied to it; others appear as <code>provider::model</code>.</div>
        </div>
        <div className="prov-add">
          <button onClick={() => setAdding((v) => !v)}>＋ Add provider</button>
        </div>
      </div>
      {adding && (
        <div className="prov-menu">
          {KINDS.map((k) => (
            <button key={k.kind} onClick={() => add(k.kind)}>
              <span className="prov-ic">{k.icon}</span>
              <span><b>{k.name}</b><span className="muted small">{k.desc}</span></span>
            </button>
          ))}
        </div>
      )}
      {!list.length && <div className="muted">No providers. Add one to start chatting.</div>}
      {list.map((p, i) => (
        <div key={p.id} className={`prov ${p.enabled === false ? 'off' : ''}`}>
          <div className="prov-row" onClick={() => setOpen(open === p.id ? null : p.id)}>
            <span className="prov-ic">{KIND_ICON[p.kind]}</span>
            <span className="prov-name"><b>{p.name}</b><span className="muted small">{KIND_NAME[p.kind]} · {summary(p)}</span></span>
            {i === 0 && <span className="tag">primary</span>}
            {p.enabled === false && <span className="tag">disabled</span>}
            <span className="muted">{open === p.id ? '▾' : '▸'}</span>
          </div>
          {open === p.id && (
            <div className="prov-body">
              <div className="row2">
                <label>Name<input value={p.name} onChange={(e) => upd(p.id, { name: e.target.value })} /></label>
                <label>ID (model prefix)<input value={p.id} disabled title="Fixed once created: chats store models as id::model" /></label>
              </div>
              {p.kind === 'vertex' ? (
                <>
                  <div className="row2">
                    <label>GCP project<input value={p.project ?? ''} placeholder="my-gcp-project" onChange={(e) => upd(p.id, { project: e.target.value })} /></label>
                    <label>Default location<input value={p.location ?? ''} placeholder="global" onChange={(e) => upd(p.id, { location: e.target.value })} /></label>
                  </div>
                  <label>Service-account key (JSON file path; only the path is saved)
                    <span className="input-btn">
                      <input value={p.credentialsPath ?? ''} placeholder="Empty = GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default login" onChange={(e) => upd(p.id, { credentialsPath: e.target.value })} />
                      <button onClick={() => pickKey(p)}>Choose…</button>
                    </span>
                  </label>
                  <label><span>Models (one per line: <code>publisher/model</code>, optional <code>@location</code>, <code>describe</code> for text-only models)</span>
                    <textarea rows={6} value={(p.models ?? []).join('\n')} placeholder={'anthropic/claude-sonnet-5\ngoogle/gemini-2.5-pro\nzai-org/glm-5.2-maas describe'} onChange={(e) => upd(p.id, { models: e.target.value.split('\n') })} />
                    <span className="muted small">{parseVertexModels(p.models ?? [], p.location || 'global').length} models · Claude uses the Anthropic endpoint with prompt caching; others use Vertex's OpenAI-compatible endpoint.</span>
                  </label>
                  <div className="row2">
                    <label>Vision model for text-only models<input value={p.visionModel ?? ''} placeholder="google/gemini-3.8-flash" onChange={(e) => upd(p.id, { visionModel: e.target.value })} /></label>
                    <label>Claude prompt cache
                      <select value={p.cacheTtl ?? '5m'} onChange={(e) => upd(p.id, { cacheTtl: e.target.value as ProviderEntry['cacheTtl'] })}>
                        <option value="5m">5 minutes (default)</option>
                        <option value="1h">1 hour (2× write cost)</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                  </div>
                </>
              ) : p.kind === 'azure' ? (
                <>
                  <label>Resource host<input value={p.baseUrl} placeholder="https://<resource>.openai.azure.com" onChange={(e) => upd(p.id, { baseUrl: e.target.value })} /></label>
                  <div className="row2">
                    <label>API key<input type="password" value={p.apiKey} onChange={(e) => upd(p.id, { apiKey: e.target.value })} /></label>
                    <label>API version<input value={p.apiVersion ?? ''} placeholder="2025-04-01-preview" onChange={(e) => upd(p.id, { apiVersion: e.target.value })} /></label>
                  </div>
                  <label>Deployment names (one per line; each becomes a model)
                    <textarea rows={3} value={(p.deployments ?? []).join('\n')} placeholder={'gpt-5\ngpt-4.1-mini'} onChange={(e) => upd(p.id, { deployments: e.target.value.split('\n') })} />
                  </label>
                </>
              ) : (
                <>
                  <label>Base URL (OpenAI-compatible, ends in /v1)<input value={p.baseUrl} onChange={(e) => upd(p.id, { baseUrl: e.target.value })} /></label>
                  <label>API key<input type="password" value={p.apiKey} onChange={(e) => upd(p.id, { apiKey: e.target.value })} /></label>
                </>
              )}
              <div className="row-actions">
                <button onClick={() => test(p)}>Test</button>
                {p.kind === 'vertex' && <button onClick={() => importProxy(p)} title="Fill project, models and key path from ~/heb-model-proxy">Import from model proxy</button>}
                <button onClick={() => upd(p.id, { enabled: p.enabled === false })}>{p.enabled === false ? 'Enable' : 'Disable'}</button>
                {i > 0 && <button className="danger" onClick={() => remove(p.id)}>Remove</button>}
                <span className="muted small prov-status">{status[p.id]}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
