import { contextBridge, ipcRenderer } from 'electron'
import type { DeskApi, PushEvent } from '../shared/api'

const inv = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

const api: DeskApi = {
  listSessions: inv('listSessions') as any,
  addFolder: inv('addFolder') as any,
  removeFolder: inv('removeFolder') as any,
  forkSession: inv('forkSession') as any,
  openSession: inv('openSession') as any,
  createSession: inv('createSession') as any,
  deleteSession: inv('deleteSession') as any,
  send: inv('send') as any,
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
