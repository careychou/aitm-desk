import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProviderConfig { baseUrl: string; apiKey: string }

/** Legacy local-proxy config files that may hold an api_key (first found wins). */
const KEY_FILES = [['.aitm-desk', 'provider.json'], ['heb-model-proxy', 'models.json']]

/** Default provider: an OpenAI-compatible endpoint on localhost (override with AITM_BASE_URL / AITM_API_KEY or in Settings). */
export function defaultProvider(): ProviderConfig {
  let apiKey = process.env.AITM_API_KEY ?? ''
  for (const parts of KEY_FILES) {
    if (apiKey) break
    try { apiKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), ...parts), 'utf8')).api_key ?? '' } catch { /* none */ }
  }
  return { baseUrl: process.env.AITM_BASE_URL ?? 'http://127.0.0.1:4141/v1', apiKey: apiKey || 'local' }
}
