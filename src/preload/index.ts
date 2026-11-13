import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DeskApi, PushEvent } from '../shared/api'

const inv = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

const api: DeskApi = {
  listSessions: inv('listSessions') as any,
  addFolder: inv('addFolder') as any,
  removeFolder: inv('removeFolder') as any,
  forkSession: inv('forkSession') as any,
  openSession: inv('openSession') as any,
  renameSession: inv('renameSession') as any,
  reorderSession: inv('reorderSession') as any,
  placeBookmark: inv('placeBookmark') as any,
  pinSession: inv('pinSession') as any,
  addBookmarkFolder: inv('addBookmarkFolder') as any,
  updateBookmark: inv('updateBookmark') as any,
  removeBookmark: inv('removeBookmark') as any,
  analyzeTurns: inv('analyzeTurns') as any,
  compact: inv('compact') as any,
  createSession: inv('createSession') as any,
  setReasoning: inv('setReasoning') as any,
  setMemories: inv('setMemories') as any,
  pickMemories: inv('pickMemories') as any,
  saveExport: inv('saveExport') as any,
  copyText: inv('copyText') as any,
  revealFile: inv('revealFile') as any,
  loadItems: inv('loadItems') as any,
  deleteSession: inv('deleteSession') as any,
  send: inv('send') as any,
  unqueue: inv('unqueue') as any,
  prepareAttachments: inv('prepareAttachments') as any,
  pickAttachments: inv('pickAttachments') as any,
  pathForFile: (f: File) => { try { return webUtils.getPathForFile(f) } catch { return '' } },
  stop: inv('stop') as any,
  saveItems: inv('saveItems') as any,
  setModel: inv('setModel') as any,
  respondPermission: inv('respondPermission') as any,
  respondAsk: inv('respondAsk') as any,
  listModels: inv('listModels') as any,
  pickFolder: inv('pickFolder') as any,
  getSettings: inv('getSettings') as any,
  saveSettings: inv('saveSettings') as any,
  registryInfo: inv('registryInfo') as any,
  onPush(cb) {
    const h = (_e: unknown, p: PushEvent) => cb(p)
    ipcRenderer.on('push', h)
    return () => ipcRenderer.removeListener('push', h)
  }
}

contextBridge.exposeInMainWorld('desk', api)
