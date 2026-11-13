import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProviderConfig { baseUrl: string; apiKey: string }

/** Default provider: heb-model-proxy on localhost, reading its api_key from ~/heb-model-proxy/models.json if present. */
export function defaultProvider(): ProviderConfig {
  let apiKey = process.env.AITM_API_KEY ?? ''
  if (!apiKey) {
    try { apiKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'heb-model-proxy', 'models.json'), 'utf8')).api_key ?? '' } catch { /* none */ }
  }
  return { baseUrl: process.env.AITM_BASE_URL ?? 'http://127.0.0.1:4141/v1', apiKey: apiKey || 'heb-local' }
}
