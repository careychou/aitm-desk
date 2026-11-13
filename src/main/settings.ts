import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, safeStorage } from 'electron'
import { defaultProvider } from '../engine/config'

export interface Settings {
  baseUrl: string
  apiKey: string
  defaultModel: string
  defaultCwd: string
  maxConcurrency: number
  maxTurnsMain: number
  maxTurnsSub: number
}

const file = () => path.join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  const d = defaultProvider()
  const defaults: Settings = { baseUrl: d.baseUrl, apiKey: d.apiKey, defaultModel: 'anthropic/claude-sonnet-5', defaultCwd: os.homedir(), maxConcurrency: 4, maxTurnsMain: 50, maxTurnsSub: 30 }
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
