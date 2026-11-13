import type { AgentEvent, PermissionDecision, PermissionKind } from '../engine/types'
import type { SessionRow, FolderRow } from '../main/store'
import type { Settings } from '../main/settings'

export type { AgentEvent, SessionRow, FolderRow, Settings, PermissionDecision }

/** Messages pushed from main to renderer. */
export type PushEvent =
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'permission'; sessionId: string; requestId: string; agentId: string; kind: PermissionKind; detail: string }
  | { type: 'ask'; sessionId: string; requestId: string; agentId: string; question: string; choices?: string[] }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'sessions'; sessions: SessionRow[]; folders: FolderRow[] }

export interface RegistryInfo { skills: Array<{ name: string; description: string; source: string }>; agents: Array<{ name: string; description: string; source: string }>; warnings: string[] }

export interface DeskApi {
  listSessions(): Promise<{ sessions: SessionRow[]; folders: FolderRow[] }>
  addFolder(): Promise<string | null>
  removeFolder(path: string): Promise<void>
  forkSession(id: string, turn: number): Promise<SessionRow>
  openSession(id: string): Promise<{ session: SessionRow; items: unknown[]; busy: boolean }>
  createSession(opts: { cwd: string; model: string; reasoning?: Settings['reasoning']; memories?: string[] }): Promise<SessionRow>
  setReasoning(sessionId: string, r: Settings['reasoning']): Promise<void>
  setMemories(sessionId: string, paths: string[]): Promise<void>
  pickMemories(): Promise<string[]>
  saveExport(name: string, markdown: string): Promise<string | null>
  copyText(text: string): Promise<void>
  revealFile(path: string): Promise<void>
  loadItems(sessionId: string): Promise<unknown[]>
  deleteSession(id: string): Promise<void>
  send(sessionId: string, prompt: string): Promise<void>
  stop(sessionId: string): Promise<void>
  saveItems(sessionId: string, items: unknown[]): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  respondAsk(requestId: string, answer: string): Promise<void>
  listModels(): Promise<{ models: string[]; error?: string }>
  pickFolder(): Promise<string | null>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  registryInfo(cwd: string): Promise<RegistryInfo>
  onPush(cb: (e: PushEvent) => void): () => void
}
