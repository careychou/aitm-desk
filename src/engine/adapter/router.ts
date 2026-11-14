import type { ChatRequest, Delta, ModelAdapter } from '../types'
import { OpenAIAdapter, type AdapterConfig } from './openai'
import type { RequestBudget } from '../content'

import { qualify, splitModel, type ModelGroup, type ProviderEntry } from '../../shared/providers'
export * from '../../shared/providers'

/** Routes each request to the provider that owns the model id. */
export class ProviderRouter implements ModelAdapter {
  private adapters = new Map<string, OpenAIAdapter>()
  private list: ProviderEntry[]
  /** Owner of unprefixed model ids: always the first stored provider, even when disabled, so ids never silently move to another provider. */
  private home?: ProviderEntry

  constructor(providers: ProviderEntry[], budget?: () => RequestBudget) {
    this.home = providers[0]
    this.list = providers.filter((p) => p.enabled !== false)
    for (const p of this.list) {
      const cfg: AdapterConfig = { baseUrl: p.baseUrl, apiKey: p.apiKey, kind: p.kind, apiVersion: p.apiVersion, deployments: p.deployments, budget }
      this.adapters.set(p.id, new OpenAIAdapter(cfg))
    }
  }

  private resolve(model: string): { adapter: OpenAIAdapter; model: string } {
    const { provider, model: bare } = splitModel(model)
    const id = provider ?? this.home?.id
    const a = id ? this.adapters.get(id) : undefined
    if (!a) throw new Error(id ? `model provider "${provider ?? this.home?.name}" is not configured or is disabled (Settings → Model providers)` : 'no model provider is configured (Settings → Model providers)')
    return { adapter: a, model: bare }
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const { adapter, model } = this.resolve(req.model)
    return adapter.stream({ ...req, model }, signal)
  }

  async listGroups(): Promise<ModelGroup[]> {
    return Promise.all(this.list.map(async (p) => {
      try {
        const ms = await this.adapters.get(p.id)!.listModels()
        return { provider: p.id, name: p.name, kind: p.kind, models: p.id === this.home?.id ? ms : ms.map((m) => qualify(p.id, m)) }
      } catch (e: any) {
        return { provider: p.id, name: p.name, kind: p.kind, models: [], error: String(e.message ?? e) }
      }
    }))
  }

  async listModels(): Promise<string[]> {
    const g = await this.listGroups()
    if (g.length && g.every((x) => x.error)) throw new Error(g.map((x) => `${x.name}: ${x.error}`).join('; '))
    return g.flatMap((x) => x.models)
  }
}
