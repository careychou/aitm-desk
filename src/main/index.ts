import { app, BrowserWindow, ipcMain, dialog, clipboard, shell as eshell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { loadSettings, saveSettings, type Settings } from './settings'
import { OpenAIAdapter } from '../engine/adapter/openai'
import { Session } from '../engine/engine'
import { loadRegistry } from '../engine/registry/registry'
import type { PermissionDecision } from '../engine/types'
import type { PushEvent } from '../shared/api'
import { sliceItemsAtTurn, sliceMessagesAtTurn } from '../shared/fork'

// GUI apps launched from Finder get a minimal PATH; give shell tools a usable one.
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')].filter(Boolean).join(':')

let win: BrowserWindow | null = null
let store: Store
let settings: Settings
const live = new Map<string, Session>()
const pending = new Map<string, (v: any) => void>()

const push = (e: PushEvent) => win?.webContents.send('push', e)
const listing = () => ({ sessions: store.listSessions(), folders: store.listFolders() })
const pushSessions = () => push({ type: 'sessions', ...listing() })
type Effort = Settings['reasoning']
const effortOf = (row: { reasoning?: string | null }): Effort => (row.reasoning as Effort) || settings.reasoning
const memoriesOf = (row: { memories?: string | null }): string[] => { try { return JSON.parse(row.memories || '[]') } catch { return [] } }
const sharesDir = () => path.join(app.getPath('documents'), 'AITM Desk', 'shares')
const adapter = () => new OpenAIAdapter({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })

function getLive(id: string): Session {
  let s = live.get(id)
  if (s) return s
  const row = store.getSession(id)
  if (!row) throw new Error(`no session ${id}`)
  s = new Session({
    adapter: adapter(), cwd: row.cwd, model: row.model, history: store.loadMessages(id),
    maxConcurrency: settings.maxConcurrency, maxTurnsMain: settings.maxTurnsMain, maxTurnsSub: settings.maxTurnsSub, reasoning: effortOf(row), memories: memoriesOf(row),
    hooks: {
      onEvent: (event) => push({ type: 'agent', sessionId: id, event }),
      requestPermission: (r) => new Promise<PermissionDecision>((resolve) => {
        const requestId = randomUUID()
        pending.set(requestId, resolve)
        push({ type: 'permission', sessionId: id, requestId, ...r })
      }),
      askUser: (r) => new Promise<string>((resolve) => {
        const requestId = randomUUID()
        pending.set(requestId, resolve)
        push({ type: 'ask', sessionId: id, requestId, ...r })
      })
    }
  })
  const sess = s
  sess.onIdleNotification = () => { void run(id, sess) }
  live.set(id, s)
  return s
}

async function run(id: string, s: Session, prompt?: string) {
  if (s.isBusy) return
  push({ type: 'busy', sessionId: id, busy: true })
  try {
    await s.send(prompt)
  } finally {
    store.saveMessages(id, s.messages.slice(1))
    store.updateSession(id, {})
    push({ type: 'busy', sessionId: id, busy: false })
    pushSessions()
  }
}

function registerIpc() {
  ipcMain.handle('listSessions', () => listing())
  ipcMain.handle('addFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a working folder' })
    if (r.canceled) return null
    store.addFolder(r.filePaths[0]); pushSessions()
    return r.filePaths[0]
  })
  ipcMain.handle('removeFolder', (_e, p: string) => {
    for (const s of store.listSessions().filter((x) => x.cwd === p)) { live.get(s.id)?.stop(); live.delete(s.id) }
    store.removeFolder(p); pushSessions()
  })
  ipcMain.handle('forkSession', (_e, id: string, turn: number) => {
    const src = store.getSession(id)
    if (!src) throw new Error(`no session ${id}`)
    const sess = live.get(id)
    const msgs = sess ? sess.messages.slice(1) : store.loadMessages(id)
    const now = Date.now()
    const row = { id: randomUUID(), title: `${src.title.replace(/^↳ /, '')} · fork`, cwd: src.cwd, model: src.model, created_at: now, updated_at: now, parent_id: id, fork_turn: turn, reasoning: src.reasoning ?? null, memories: src.memories ?? null }
    store.createSession(row)
    store.saveMessages(row.id, sliceMessagesAtTurn(msgs, turn))
    store.saveUiItems(row.id, sliceItemsAtTurn(store.loadUiItems(id) as Array<{ t: string }>, turn))
    pushSessions()
    return row
  })
  ipcMain.handle('openSession', (_e, id: string) => {
    const session = store.getSession(id)
    return { session, items: store.loadUiItems(id), busy: live.get(id)?.isBusy ?? false }
  })
  ipcMain.handle('createSession', (_e, o: { cwd: string; model: string; reasoning?: Effort; memories?: string[] }) => {
    const now = Date.now()
    const row = { id: randomUUID(), title: 'New chat', cwd: o.cwd, model: o.model, created_at: now, updated_at: now, parent_id: null, fork_turn: null,
      reasoning: o.reasoning ?? null, memories: o.memories?.length ? JSON.stringify(o.memories) : null }
    store.createSession(row)
    settings.defaultCwd = o.cwd; settings.defaultModel = o.model; saveSettings(settings)
    return row
  })
  ipcMain.handle('deleteSession', (_e, id: string) => { live.get(id)?.stop(); live.delete(id); store.deleteSession(id); pushSessions() })
  ipcMain.handle('send', (_e, id: string, prompt: string) => {
    const row = store.getSession(id)
    if (row && row.title === 'New chat') store.updateSession(id, { title: prompt.replace(/\s+/g, ' ').slice(0, 60) })
    void run(id, getLive(id), prompt)
  })
  ipcMain.handle('stop', (_e, id: string) => live.get(id)?.stop())
  ipcMain.handle('saveItems', (_e, id: string, items: unknown[]) => store.saveUiItems(id, items))
  ipcMain.handle('setModel', (_e, id: string, model: string) => { store.updateSession(id, { model }); live.get(id)?.setModel(model); settings.defaultModel = model; saveSettings(settings) })
  ipcMain.handle('setReasoning', (_e, id: string, r: Effort) => { store.updateSession(id, { reasoning: r }); live.get(id)?.setReasoning(r) })
  ipcMain.handle('setMemories', (_e, id: string, paths: string[]) => {
    store.updateSession(id, { memories: paths.length ? JSON.stringify(paths) : null }); live.get(id)?.setMemories(paths); pushSessions()
  })
  ipcMain.handle('pickMemories', async () => {
    fs.mkdirSync(sharesDir(), { recursive: true })
    const r = await dialog.showOpenDialog(win!, { defaultPath: sharesDir(), properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }], message: 'Attach shared session exports as memory' })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('saveExport', async (_e, name: string, md: string) => {
    fs.mkdirSync(sharesDir(), { recursive: true })
    const safe = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'session'
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(sharesDir(), `${safe}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, md)
    return r.filePath
  })
  ipcMain.handle('copyText', (_e, t: string) => clipboard.writeText(t))
  ipcMain.handle('revealFile', (_e, p: string) => eshell.showItemInFolder(p))
  ipcMain.handle('loadItems', (_e, id: string) => store.loadUiItems(id))
  ipcMain.handle('respondPermission', (_e, rid: string, d: PermissionDecision) => { pending.get(rid)?.(d); pending.delete(rid) })
  ipcMain.handle('respondAsk', (_e, rid: string, a: string) => { pending.get(rid)?.(a); pending.delete(rid) })
  ipcMain.handle('listModels', async () => {
    try { return { models: await adapter().listModels() } } catch (e: any) { return { models: [], error: e.message } }
  })
  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('getSettings', () => settings)
  ipcMain.handle('saveSettings', (_e, s: Settings) => {
    settings = s; saveSettings(s)
    for (const [id, sess] of live) { if (!store.getSession(id)?.reasoning) sess.setReasoning(s.reasoning); if (!sess.isBusy) live.delete(id) }
  })
  ipcMain.handle('registryInfo', (_e, cwd: string) => {
    const r = loadRegistry({ cwd })
    return {
      skills: r.skills.map(({ name, description, source }) => ({ name, description, source })),
      agents: r.agents.map(({ name, description, source }) => ({ name, description, source })),
      warnings: r.warnings
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 820, minHeight: 560,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { void eshell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  app.setName('AITM Desk')
  settings = loadSettings()
  store = new Store(app.getPath('userData'))
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  for (const s of live.values()) s.stop()
  if (process.platform !== 'darwin') app.quit()
})
