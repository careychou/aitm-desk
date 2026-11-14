/** Model-provider types and pure helpers, shared by the engine router, main process and renderer. */

export type ProviderKind = 'openai' | 'azure' | 'vertex'

/** One configured model provider (Settings → Model providers). */
export interface ProviderEntry {
  id: string
  name: string
  kind: ProviderKind
  /** OpenAI-compatible base URL, or the Azure resource host (https://<resource>.openai.azure.com). */
  baseUrl: string
  apiKey: string
  /** Azure only. */
  apiVersion?: string
  /** Azure only: deployment names (each is a model in the picker). */
  deployments?: string[]
  /** Vertex only: GCP project id. */
  project?: string
  /** Vertex only: default region (`global` for Model Bank MaaS models). */
  location?: string
  /** Vertex only: path to a service-account JSON key (the key itself is never stored). Empty = ADC / gcloud. */
  credentialsPath?: string
  /** Vertex only: model lines, `<publisher>/<model> [@location] [describe]`. */
  models?: string[]
  /** Vertex only: model that transcribes images for text-only (`describe`) models. */
  visionModel?: string
  /** Vertex only: Claude prompt-cache TTL. */
  cacheTtl?: '5m' | '1h' | 'off'
  enabled?: boolean
}

export interface VertexModel { id: string; location: string; vision: true | 'describe' }

/**
 * Parses Vertex model lines: `anthropic/claude-sonnet-5`, `google/gemini-2.5-pro @us-central1`,
 * `zai-org/glm-5.2-maas describe` (text-only: images are transcribed by the vision model).
 * Blank lines and `#` comments are ignored.
 */
export function parseVertexModels(lines: string[], defaultLocation = 'global'): VertexModel[] {
  const out: VertexModel[] = []
  for (const raw of lines) {
    const toks = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean)
    if (!toks.length) continue
    const m: VertexModel = { id: toks[0], location: defaultLocation, vision: true }
    for (const t of toks.slice(1)) {
      if (t.startsWith('@') && t.length > 1) m.location = t.slice(1)
      else if (/^(describe|text-only|novision)$/i.test(t)) m.vision = 'describe'
    }
    if (!out.some((x) => x.id === m.id)) out.push(m)
  }
  return out
}

/** Model lines from a heb-model-proxy style models.json (`models: [{id, location, vision}]`). */
export function vertexLinesFromProxy(cfg: { default_location?: string; models?: Array<{ id: string; location?: string; vision?: unknown }> }): string[] {
  const def = cfg.default_location || 'global'
  return (cfg.models ?? []).filter((m) => m?.id).map((m) => [m.id, m.location && m.location !== def ? `@${m.location}` : '', m.vision === 'describe' ? 'describe' : ''].filter(Boolean).join(' '))
}

export interface ModelGroup { provider: string; name: string; kind: ProviderKind; models: string[]; error?: string }

/** Models of every provider after the first are qualified as `<providerId>::<model>`; the first provider's stay bare (so existing chats keep working). */
export const SEP = '::'
export const qualify = (providerId: string, model: string) => `${providerId}${SEP}${model}`
export function splitModel(model: string): { provider: string | null; model: string } {
  const i = model.indexOf(SEP)
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + SEP.length) } : { provider: null, model }
}
/** The model name without any provider prefix (for display and pricing). */
export const bareModel = (model: string) => splitModel(model).model

/** Lower-case slug unique among `taken`. */
export function providerId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'
  let id = base, n = 2
  while (taken.includes(id)) id = `${base}-${n++}`
  return id
}

/**
 * Normalizes stored settings: decrypts per-provider keys, and turns the pre-0.8 single endpoint
 * (`baseUrl` + `apiKey`/`apiKeyEnc`) into the first provider entry. Pure: `dec` decrypts a stored key.
 */
export function migrateProviders(raw: Record<string, any>, fallback: ProviderEntry, dec: (enc?: string) => string | undefined): Record<string, any> & { providers?: ProviderEntry[] } {
  const { baseUrl, apiKey, apiKeyEnc, ...rest } = raw
  if (Array.isArray(rest.providers)) {
    rest.providers = rest.providers.map(({ apiKeyEnc: e, ...p }: any) => ({ ...p, apiKey: dec(e) ?? p.apiKey ?? '' }))
  } else if (baseUrl || apiKeyEnc || apiKey) {
    rest.providers = [{ ...fallback, baseUrl: baseUrl ?? fallback.baseUrl, apiKey: dec(apiKeyEnc) ?? apiKey ?? fallback.apiKey }]
  }
  return rest
}
