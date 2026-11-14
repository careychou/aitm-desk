import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** Access tokens live ~60 min; refresh after 40 like the model proxy. */
const TTL_MS = 40 * 60_000

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** RS256-signed JWT assertion for the OAuth2 JWT-bearer grant (no google-auth dependency). */
export function signJwt(clientEmail: string, privateKey: string, aud: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud, iat: now, exp: now + 3600 }))
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKey)
  return `${head}.${claims}.${b64url(sig)}`
}

const adcPath = () => path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json')

/**
 * Google OAuth access tokens for Vertex AI. Order: the configured key file (service account or
 * user ADC JSON) → $GOOGLE_APPLICATION_CREDENTIALS → gcloud ADC file → `gcloud auth print-access-token`.
 * Only the file PATH is configured; the key is read on demand and never stored or logged.
 */
export class VertexAuth {
  private cached?: { value: string; at: number }
  private inflight?: Promise<string>
  /** Human-readable credential source, e.g. `service account x@y.iam.gserviceaccount.com`. */
  mode = ''

  constructor(private keyPath: string) {}

  async token(force = false): Promise<string> {
    if (!force && this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.value
    this.inflight ??= this.mint().finally(() => { this.inflight = undefined })
    const value = await this.inflight
    this.cached = { value, at: Date.now() }
    return value
  }

  private keyFile(): string | null {
    const p = this.keyPath.trim().replace(/^~(?=\/|$)/, os.homedir())
    if (p) {
      if (!fs.existsSync(p)) throw new Error(`service-account key not found: ${p}`)
      return p
    }
    const env = process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (env && fs.existsSync(env)) return env
    return fs.existsSync(adcPath()) ? adcPath() : null
  }

  private async mint(): Promise<string> {
    const file = this.keyFile()
    if (!file) return this.gcloud()
    let j: any
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`could not read credentials JSON: ${file}`) }
    if (j.type === 'service_account') {
      if (!j.client_email || !j.private_key) throw new Error('service-account JSON is missing client_email/private_key')
      const uri = j.token_uri || TOKEN_URI
      this.mode = `service account ${j.client_email}`
      return this.exchange(uri, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(j.client_email, j.private_key, uri) })
    }
    if (j.type === 'authorized_user') {
      this.mode = 'gcloud application-default user'
      return this.exchange(j.token_uri || TOKEN_URI, { grant_type: 'refresh_token', refresh_token: j.refresh_token, client_id: j.client_id, client_secret: j.client_secret })
    }
    throw new Error(`unsupported credentials type "${j.type}" (expected service_account or authorized_user)`)
  }

  private async exchange(uri: string, form: Record<string, string>): Promise<string> {
    const r = await fetch(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
    const t = await r.text()
    let j: any = {}
    try { j = JSON.parse(t) } catch { /* raw */ }
    if (!r.ok || !j.access_token) throw new Error(`token exchange ${r.status}: ${j.error_description ?? j.error ?? t.slice(0, 200)}`)
    return j.access_token
  }

  private gcloud(): Promise<string> {
    this.mode = 'gcloud CLI'
    const PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), 'google-cloud-sdk', 'bin'), process.env.PATH].filter(Boolean).join(':')
    return new Promise((res, rej) => execFile('gcloud', ['auth', 'print-access-token'], { env: { ...process.env, PATH }, timeout: 20_000 }, (e, out) => {
      const tok = String(out ?? '').trim()
      if (e || !tok) rej(new Error('no Google credentials: set a service-account key file, or run `gcloud auth application-default login`'))
      else res(tok)
    }))
  }
}
