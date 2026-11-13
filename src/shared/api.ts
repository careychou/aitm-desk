import type { AgentEvent, PermissionDecision, PermissionKind } from '../engine/types'
import type { SessionRow, FolderRow, BookmarkRow } from '../main/store'
import type { Settings } from '../main/settings'
import type { Attachment } from '../engine/content'
import type { AttachMeta } from './attach'

export type { Attachment, AttachMeta }
export interface AttachInput { path?: string; name?: string; data?: Uint8Array }
export interface PreparedAttachment { id: string; att?: Attachment; meta: AttachMeta; error?: string }
export type { AgentEvent, SessionRow, FolderRow, BookmarkRow, Settings, PermissionDecision }
export interface Listing { sessions: SessionRow[]; folders: FolderRow[]; bookmarks: BookmarkRow[] }
export interface CompactItem { t: 'compact'; auto: boolean; summarized: number; dropped: number; before: number; after: number; summary: string; keptTurns?: number[]; summarizedTurns?: number[]; droppedTurns?: number[] }
export interface TurnInfo { index: number; user: string; answer: string; tools: string[]; tokens: number }
export interface TurnAnalysis { turns: TurnInfo[]; clusters: Array<{ label: string; reason?: string; turns: number[] }>; method: 'model' | 'lexical'; hasPriorSummary: boolean; tokens: number; uiTurns: number[] }

/** Messages pushed from main to renderer. */
export type PushEvent =
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'permission'; sessionId: string; requestId: string; agentId: string; kind: PermissionKind; detail: string }
  | { type: 'ask'; sessionId: string; requestId: string; agentId: string; question: string; choices?: string[] }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | ({ type: 'sessions' } & Listing)
  | { type: 'compacted'; sessionId: string; item: CompactItem; beforeTurn: number }
  | { type: 'tokens'; sessionId: string; tokens: number }

export interface RegistryInfo { skills: Array<{ name: string; description: string; source: string }>; agents: Array<{ name: string; description: string; source: string }>; warnings: string[] }

export interface DeskApi {
  listSessions(): Promise<Listing>
  addFolder(): Promise<string | null>
  removeFolder(path: string): Promise<void>
  forkSession(id: string, turn: number): Promise<SessionRow>
  openSession(id: string): Promise<{ session: SessionRow; items: unknown[]; busy: boolean; tokens: number }>
  renameSession(id: string, title: string): Promise<void>
  reorderSession(id: string, targetId: string, before: boolean): Promise<void>
  pinSession(sessionId: string, parentId: string | null, targetId?: string | null, before?: boolean): Promise<void>
  placeBookmark(id: string, parentId: string | null, targetId: string | null, before: boolean): Promise<void>
  addBookmarkFolder(name: string, parentId: string | null): Promise<void>
  updateBookmark(id: string, patch: { name?: string; parent_id?: string | null; collapsed?: number }): Promise<void>
  removeBookmark(id: string): Promise<void>
  analyzeTurns(id: string): Promise<TurnAnalysis>
  compact(id: string, plan: { keep: number[]; summarize: number[] }): Promise<{ before: number; after: number; summarized: number; dropped: number }>
  createSession(opts: { cwd: string; model: string; reasoning?: Settings['reasoning']; mode?: Settings['defaultMode']; memories?: string[] }): Promise<SessionRow>
  setReasoning(sessionId: string, r: Settings['reasoning']): Promise<void>
  setMode(sessionId: string, m: Settings['defaultMode']): Promise<void>
  setMemories(sessionId: string, paths: string[]): Promise<void>
  pickMemories(): Promise<string[]>
  saveExport(name: string, markdown: string): Promise<string | null>
  copyText(text: string): Promise<void>
  revealFile(path: string): Promise<void>
  loadItems(sessionId: string): Promise<unknown[]>
  deleteSession(id: string): Promise<void>
  /** Sends a prompt. While the chat is working it is queued under `qid` and joins at the next step. */
  send(sessionId: string, prompt: string, attachments?: Attachment[], qid?: string): Promise<void>
  /** Withdraws a queued prompt; false if it already reached the model. */
  unqueue(sessionId: string, qid: string): Promise<boolean>
  prepareAttachments(inputs: AttachInput[]): Promise<PreparedAttachment[]>
  pickAttachments(): Promise<PreparedAttachment[]>
  /** Absolute path of a dropped/pasted File ('' when it has none, e.g. a screenshot). */
  pathForFile(f: File): string
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
