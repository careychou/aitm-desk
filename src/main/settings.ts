import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, safeStorage } from 'electron'
import { defaultProvider } from '../engine/config'
import { DEFAULT_LIMITS, type AttachLimits } from '../shared/attach'

export interface Settings extends AttachLimits {
  baseUrl: string
  apiKey: string
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
  const defaults: Settings = { baseUrl: d.baseUrl, apiKey: d.apiKey, defaultModel: 'anthropic/claude-sonnet-5', defaultCwd: os.homedir(), maxConcurrency: 4, maxTurnsMain: 50, maxTurnsSub: 30, reasoning: 'medium', defaultMode: 'autopilot', autoCompact: 'suggest', compactThreshold: 80000, compactKeepRecent: 2, ...DEFAULT_LIMITS, requestMaxMB: 20, imageTurns: 4, usageCommand: '', pricingPath: '', dailyBudget: 0 }
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) raw.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'))
    delete raw.apiKeyEnc
    return { ...defaults, ...raw }
  } catch {
    return defaults
  }
}

export function saveSettings(s: Settings): void {
  const out: any = { ...s }
  if (safeStorage.isEncryptionAvailable()) { out.apiKeyEnc = safeStorage.encryptString(s.apiKey).toString('base64'); delete out.apiKey }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(out, null, 2))
}
