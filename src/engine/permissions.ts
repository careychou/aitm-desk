import type { Hooks, PermissionKind } from './types'

/** Asks the user before risky tools run; remembers "allow for session" per kind. */
export class PermissionGate {
  private allowed = new Set<PermissionKind>()
  constructor(private hooks: Hooks, private autoApprove = false) {}

  /** Autopilot: approve everything without asking. */
  setAutoApprove(on: boolean) { this.autoApprove = on }
  get isAutoApprove() { return this.autoApprove }

  async check(agentId: string, kind: PermissionKind, detail: string): Promise<boolean> {
    if (this.autoApprove || this.allowed.has(kind)) return true
    const d = await this.hooks.requestPermission({ agentId, kind, detail })
    if (d === 'allow_session') this.allowed.add(kind)
    return d !== 'deny'
  }
}
