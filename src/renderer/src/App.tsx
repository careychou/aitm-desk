import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookmarkRow, FolderRow, Listing, PreparedAttachment, PushEvent, RegistryInfo, SessionRow } from '../../shared/api'
import { insertBeforeTurn } from '../../shared/fork'
import { applyEvent, runningBackground, settle, type Item } from './state'
import { ItemList } from './components/Cards'
import { Composer, type Effort } from './components/Composer'
import { ShareModal } from './components/ShareModal'
import { CompactModal } from './components/CompactModal'
import { AskCard, PermissionCard, type AskReq, type PermissionReq } from './components/Prompts'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { BRAND } from '../../shared/brand'

const SUGGESTIONS = [
  'List the skills available in this folder and what each family is for.',
  'Write a Python script that summarizes the files in this folder, then run it.',
  'Use two parallel sub-agents to research a topic from two angles and merge the findings.'
]
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([])
  const [compacting, setCompacting] = useState<SessionRow | null>(null)
  const [tokens, setTokens] = useState(0)
  const [compactCfg, setCompactCfg] = useState({ mode: 'suggest', threshold: 80000, keep: 2 })
  const [toast, setToast] = useState('')
  const [current, setCurrent] = useState<SessionRow | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<string[]>([])
  const [modelErr, setModelErr] = useState('')
  const [draftModel, setDraftModel] = useState('')
  const [draftCwd, setDraftCwd] = useState('')
  const [defaultEffort, setDefaultEffort] = useState<Effort>('medium')
  const [draftEffort, setDraftEffort] = useState<Effort | null>(null)
  const [draftMem, setDraftMem] = useState<string[]>([])
  const [sharing, setSharing] = useState<SessionRow | null>(null)
  const [reg, setReg] = useState<RegistryInfo | null>(null)
  const [folderMenu, setFolderMenu] = useState(false)
  const [perms, setPerms] = useState<PermissionReq[]>([])
  const [asks, setAsks] = useState<AskReq[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const currentRef = useRef<SessionRow | null>(null)
  const itemsRef = useRef<Item[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  currentRef.current = current
  itemsRef.current = items

  const applyListing = (l: Listing) => {
    setSessions(l.sessions); setFolders(l.folders); setBookmarks(l.bookmarks ?? [])
    const cur = currentRef.current
    if (cur) {
      const fresh = l.sessions.find((s) => s.id === cur.id)
      if (fresh && (fresh.title !== cur.title || fresh.memories !== cur.memories)) setCurrent({ ...cur, title: fresh.title, memories: fresh.memories })
    }
  }

  const refreshModels = useCallback(async () => {
    const r = await window.desk.listModels()
    setModels(r.models); setModelErr(r.error ?? '')
  }, [])

  useEffect(() => {
    void window.desk.listSessions().then(applyListing)
    void window.desk.getSettings().then((s) => { setDraftModel(s.defaultModel); setDraftCwd(s.defaultCwd); setDefaultEffort(s.reasoning); setCompactCfg({ mode: s.autoCompact, threshold: s.compactThreshold, keep: s.compactKeepRecent }) })
    void refreshModels()
    return window.desk.onPush((p: PushEvent) => {
      if (p.type === 'sessions') { applyListing(p); return }
      if (p.type === 'busy') setBusyIds((prev) => { const n = new Set(prev); p.busy ? n.add(p.sessionId) : n.delete(p.sessionId); return n })
      if (p.sessionId !== currentRef.current?.id) return
      if (p.type === 'tokens') { setTokens(p.tokens); return }
      if (p.type === 'compacted') { setItems((prev) => insertBeforeTurn(prev, p.item as unknown as Item, p.beforeTurn)); return }
      if (p.type === 'agent') setItems((prev) => applyEvent(prev, p.event))
      else if (p.type === 'busy') {
        setBusy(p.busy)
        if (!p.busy) { setPerms([]); setAsks([]); void window.desk.saveItems(p.sessionId, itemsRef.current) }
      } else if (p.type === 'permission') setPerms((x) => [...x, p])
      else if (p.type === 'ask') setAsks((x) => [...x, p])
    })
  }, [refreshModels])

  // skills/agents are discovered per working folder (folder .github + ~/.copilot)
  const cwd = current?.cwd ?? draftCwd
  useEffect(() => { if (cwd) void window.desk.registryInfo(cwd).then(setReg) }, [cwd])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, perms, asks])

  const persistCurrent = async () => {
    if (current && !busy) await window.desk.saveItems(current.id, itemsRef.current)
  }

  const open = async (id: string) => {
    if (id === current?.id) return
    await persistCurrent()
    const r = await window.desk.openSession(id)
    setCurrent(r.session); setItems(r.busy ? (r.items as Item[]) : settle(r.items as Item[])); setBusy(r.busy); setPerms([]); setAsks([]); setTokens(r.tokens)
    stick.current = true
  }

  const newChat = async (folder: string) => {
    await persistCurrent()
    if (folder) setDraftCwd(folder)
    setCurrent(null); setItems([]); setBusy(false); setPerms([]); setAsks([]); setFolderMenu(false); setDraftEffort(null); setDraftMem([]); setTokens(0)
  }

  const send = async (text: string, atts: PreparedAttachment[] = []) => {
    let s = current
    if (!s) {
      s = await window.desk.createSession({ cwd: draftCwd, model: draftModel, reasoning: draftEffort ?? undefined, memories: draftMem })
      setCurrent(s); currentRef.current = s
    }
    stick.current = true
    setItems((prev) => [...prev, atts.length ? { t: 'user', text, attachments: atts.map((a) => a.meta) } : { t: 'user', text }])
    setBusy(true)
    await window.desk.send(s.id, text, atts.map((a) => a.att!))
  }

  const fork = async (turn: number) => {
    if (!current) return
    await persistCurrent()
    const row = await window.desk.forkSession(current.id, turn)
    await open(row.id)
  }

  const setModel = async (m: string) => {
    if (current) { await window.desk.setModel(current.id, m); setCurrent({ ...current, model: m }) }
    else setDraftModel(m)
  }

  const effort: Effort = ((current ? current.reasoning : draftEffort) as Effort) || defaultEffort
  const setEffort = async (e: Effort) => {
    if (current) { await window.desk.setReasoning(current.id, e); setCurrent({ ...current, reasoning: e }) }
    else setDraftEffort(e)
  }
  const memories: string[] = current ? JSON.parse(current.memories || '[]') : draftMem
  const setMemories = async (paths: string[]) => {
    const uniq = [...new Set(paths)]
    if (current) { await window.desk.setMemories(current.id, uniq); setCurrent({ ...current, memories: uniq.length ? JSON.stringify(uniq) : null }) }
    else setDraftMem(uniq)
  }
  const addMemory = async () => { const p = await window.desk.pickMemories(); if (p.length) await setMemories([...memories, ...p]) }

  const openCompact = async (s: SessionRow) => {
    if (busyIds.has(s.id)) { flash('Wait for this chat to finish before compacting.'); return }
    await persistCurrent()
    if (s.id !== current?.id) await open(s.id)
    setCompacting(s)
  }
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }
  const overThreshold = !!current && compactCfg.mode !== 'off' && tokens > compactCfg.threshold

  const addFolder = async () => {
    const f = await window.desk.addFolder()
    if (f) await newChat(f)
  }

  const removeFolder = async (p: string) => {
    const n = sessions.filter((s) => s.cwd === p).length
    if (!confirm(`Remove "${base(p)}" from the sidebar${n ? ` and delete its ${n} chat(s)` : ''}? Files on disk are not touched.`)) return
    await window.desk.removeFolder(p)
    if (current?.cwd === p) void newChat('')
  }

  const del = async (s: SessionRow) => {
    const kids = sessions.filter((x) => x.parent_id === s.id).length
    if (!confirm(`Delete "${s.title}"?${kids ? ` Its ${kids} fork(s) will move up one level.` : ''}`)) return
    await window.desk.deleteSession(s.id)
    if (current?.id === s.id) void newChat('')
  }

  const bg = runningBackground(items)
  const model = current?.model ?? draftModel
  const parent = current?.parent_id ? sessions.find((s) => s.id === current.parent_id) : null

  const composer = (
    <Composer busy={busy} model={model} models={models} cwd={cwd} onModel={setModel}
      onPickFolder={current ? undefined : () => setFolderMenu(!folderMenu)} onSend={send} onStop={() => current && window.desk.stop(current.id)} autoFocus
      effort={effort} onEffort={setEffort} memories={memories} onAddMemory={addMemory} onRemoveMemory={(m) => setMemories(memories.filter((x) => x !== m))}
      onShare={current && !busy ? async () => { await persistCurrent(); setSharing(current) } : undefined}
      tokens={current ? tokens : 0} onCompact={current && !busy ? () => openCompact(current) : undefined} />
  )

  return (
    <div className={`app ${sidebar ? '' : 'nosidebar'}`}>
      {sidebar && (
        <Sidebar folders={folders} sessions={sessions} bookmarks={bookmarks} onCompact={openCompact} currentId={current?.id ?? null} busyIds={busyIds}
          onOpen={open} onNewChat={newChat} onDelete={del} onAddFolder={addFolder} onRemoveFolder={removeFolder}
          onCollapse={() => setSidebar(false)} onSettings={() => setShowSettings(true)}
          onShare={async (s) => { await persistCurrent(); setSharing(s) }} />
      )}

      <main className="main">
        {!sidebar && <button className="icon float-toggle" onClick={() => setSidebar(true)}>◧</button>}
        <div className="drag" />
        {current && (
          <div className="header">
            <span className="crumb" title={current.cwd}>📂 {base(current.cwd)}</span>
            {parent && <><span className="sep">›</span><button className="crumb link" onClick={() => open(parent.id)}>{parent.title}</button></>}
            <span className="sep">›</span><span className="crumb strong">{current.title}</span>
            {current.parent_id && current.fork_turn !== null && <span className="fork-badge">⑂ forked at turn {current.fork_turn + 1}</span>}
          </div>
        )}
        {!current && items.length === 0 ? (
          <div className="empty">
            {BRAND.logo ? <div className="logo brand-logo"><img src={BRAND.logo} alt="" /><span>{BRAND.short}</span></div> : <div className="logo">◆</div>}
            <div className="wide composer-anchor">
              {composer}
              {folderMenu && (
                <div className="folder-menu">
                  {folders.map((f) => (
                    <button key={f.path} className={f.path === draftCwd ? 'on' : ''} onClick={() => { setDraftCwd(f.path); setFolderMenu(false) }}>
                      📂 {base(f.path)} <span className="muted">{f.path}</span>
                    </button>
                  ))}
                  <button onClick={() => { setFolderMenu(false); void addFolder() }}>＋ Choose another folder…</button>
                </div>
              )}
            </div>
            {reg && <div className="reg-line">{reg.skills.length} skills · {reg.agents.length} agents loaded from <code>{base(cwd)}/.github</code> + <code>~/.copilot</code></div>}
            {modelErr && <div className="err wide">Model provider unreachable: {modelErr} — check Settings.</div>}
            <div className="suggestions wide">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
            <div className="foot">{BRAND.title} uses AI. Check for mistakes.</div>
          </div>
        ) : (
          <>
            <div className="scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
              <div className="thread">
                <ItemList items={items} live={busy} onFork={fork} />
                {busy && perms.length === 0 && asks.length === 0 && <div className="working"><span className="spinner" /> Working…</div>}
                {perms.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={(d) => { void window.desk.respondPermission(r.requestId, d); setPerms((x) => x.filter((y) => y.requestId !== r.requestId)) }} />)}
                {asks.map((r) => <AskCard key={r.requestId} req={r} onAnswer={(a) => { void window.desk.respondAsk(r.requestId, a); setAsks((x) => x.filter((y) => y.requestId !== r.requestId)); setItems((p) => [...p, { t: 'answer', text: a }]) }} />)}
              </div>
            </div>
            <div className="bottom">
              {overThreshold && !busy && (
                <div className="compact-banner">
                  This chat is long (~{Math.round(tokens / 1000)}k tokens).{compactCfg.mode === 'auto' ? ' It will be auto-compacted before your next message, or' : ''} Compact it to keep the agent focused and fast.
                  <button onClick={() => current && openCompact(current)}>Choose turns…</button>
                </div>
              )}
              {bg.length > 0 && <div className="tray">{bg.map((a) => <span key={a.agentId} className="chip"><span className="spinner" /> {a.name} · {a.agentId}</span>)}</div>}
              {composer}
            </div>
          </>
        )}
      </main>
      {showSettings && <SettingsModal cwd={cwd} onClose={() => { setShowSettings(false); void refreshModels(); void window.desk.getSettings().then((s) => { setDefaultEffort(s.reasoning); setCompactCfg({ mode: s.autoCompact, threshold: s.compactThreshold, keep: s.compactKeepRecent }) }) }} />}
      {compacting && <CompactModal session={compacting} keepRecentDefault={compactCfg.keep} onClose={() => setCompacting(null)}
        onDone={(m) => { setCompacting(null); flash(m) }} />}
      {toast && <div className="toast">{toast}</div>}
      {sharing && <ShareModal session={sharing} onClose={() => setSharing(null)} />}
    </div>
  )
}
