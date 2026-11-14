/** Model-provider types and pure helpers, shared by the engine router, main process and renderer. */

export type ProviderKind = 'openai' | 'azure'

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
  enabled?: boolean
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
