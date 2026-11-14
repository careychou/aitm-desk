import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, safeStorage } from 'electron'
import { defaultProvider } from '../engine/config'
import { migrateProviders, type ProviderEntry } from '../shared/providers'
import { BRAND } from '../shared/brand'
import { DEFAULT_LIMITS, type AttachLimits } from '../shared/attach'

export interface Settings extends AttachLimits {
  /** Model providers; the first one's models appear unprefixed, others as `<id>::<model>`. */
  providers: ProviderEntry[]
  defaultModel: string
  defaultCwd: string
  maxConcurrency: number
  maxTurnsMain: number
  maxTurnsSub: number
  reasoning: 'off' | 'low' | 'medium' | 'high'
  /** Mode for new chats: autopilot runs shell/write/fetch tools without asking. */
  defaultMode: 'interactive' | 'autopilot'
  autoCompact: 'off' | 'suggest' | 'auto'
  compactThreshold: number
  compactKeepRecent: number
  /** Model used to summarize and cluster turns ('' = the chat's own model). */
  compactModel: string
  /** Auto mode: wait until the chat has been idle this long (prompt cache expired) before compacting; 0 = compact as soon as over the threshold. */
  compactIdleMinutes: number
  /** Auto mode: compact regardless of idle time above this many tokens. */
  compactHardLimit: number
  /** Auto mode: skip unless at least this many tokens would be summarized. */
  compactMinGain: number
  /** Request body cap in MB (Vertex rejects > 30 MB). */
  requestMaxMB: number
  /** Re-send images from only the last N user messages (0 = all). */
  imageTurns: number
  /** Project usage command (heb-llm-cost contract); blank = auto-detect heb-llm-cost. */
  usageCommand: string
  /** pricing.json path; blank = ~/.aitm-desk or ~/heb-model-proxy. */
  pricingPath: string
  /** Daily budget in USD for the usage ring (0 = off). */
  dailyBudget: number
}

let dir = ''
/** Must be called before load/save; points settings.json at the data home. */
export function setSettingsDir(d: string): void { dir = d }
const file = () => path.join(dir || app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  const d = defaultProvider()
  const defaults: Settings = { providers: [{ id: 'default', name: BRAND.defaultProviderName, kind: 'openai', baseUrl: d.baseUrl, apiKey: d.apiKey }], defaultModel: 'anthropic/claude-sonnet-5', defaultCwd: os.homedir(), maxConcurrency: 4, maxTurnsMain: 50, maxTurnsSub: 30, reasoning: 'medium', defaultMode: 'autopilot', autoCompact: 'suggest', compactThreshold: 80000, compactKeepRecent: 2, compactModel: BRAND.defaultCompactModel, compactIdleMinutes: 5, compactHardLimit: 120000, compactMinGain: 20000, ...DEFAULT_LIMITS, requestMaxMB: 20, imageTurns: 4, usageCommand: '', pricingPath: '', dailyBudget: 0 }
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    const dec = (enc?: string) => (enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : undefined)
    return { ...defaults, ...migrateProviders(raw, defaults.providers[0], dec) }
  } catch {
    return defaults
  }
}

export function saveSettings(s: Settings): void {
  const enc = safeStorage.isEncryptionAvailable()
  const out: any = { ...s, providers: s.providers.map(({ apiKey, ...p }) => (enc ? { ...p, apiKeyEnc: safeStorage.encryptString(apiKey).toString('base64') } : { ...p, apiKey })) }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(out, null, 2))
}
