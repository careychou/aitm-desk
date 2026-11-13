import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushEvent, SessionRow } from '../../shared/api'
import { applyEvent, runningBackground, settle, type Item } from './state'
import { ItemList } from './components/Cards'
import { Composer } from './components/Composer'
import { AskCard, PermissionCard, type AskReq, type PermissionReq } from './components/Prompts'
import { SettingsModal } from './components/SettingsModal'

const SUGGESTIONS = [
  'List the skills available in this folder and what each family is for.',
  'Write a Python script that summarizes the files in this folder, then run it.',
  'Use two parallel sub-agents to research a topic from two angles and merge the findings.'
]

export function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [current, setCurrent] = useState<SessionRow | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelErr, setModelErr] = useState('')
  const [draftModel, setDraftModel] = useState('')
  const [draftCwd, setDraftCwd] = useState('')
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

  const refreshModels = useCallback(async () => {
    const r = await window.desk.listModels()
    setModels(r.models); setModelErr(r.error ?? '')
  }, [])

  useEffect(() => {
    void window.desk.listSessions().then(setSessions)
    void window.desk.getSettings().then((s) => { setDraftModel(s.defaultModel); setDraftCwd(s.defaultCwd) })
    void refreshModels()
    return window.desk.onPush((p: PushEvent) => {
      if (p.type === 'sessions') { setSessions(p.sessions); return }
      if (p.sessionId !== currentRef.current?.id) return
      if (p.type === 'agent') setItems((prev) => applyEvent(prev, p.event))
      else if (p.type === 'busy') {
        setBusy(p.busy)
        if (!p.busy) { setPerms([]); setAsks([]); void window.desk.saveItems(p.sessionId, itemsRef.current) }
      } else if (p.type === 'permission') setPerms((x) => [...x, p])
      else if (p.type === 'ask') setAsks((x) => [...x, p])
    })
  }, [refreshModels])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, perms, asks])

  const open = async (id: string) => {
    if (current && !busy) await window.desk.saveItems(current.id, items)
    const r = await window.desk.openSession(id)
    setCurrent(r.session); setItems(r.busy ? (r.items as Item[]) : settle(r.items as Item[])); setBusy(r.busy); setPerms([]); setAsks([])
    stick.current = true
  }

  const newChat = () => { setCurrent(null); setItems([]); setBusy(false); setPerms([]); setAsks([]) }

  const send = async (text: string) => {
    let s = current
    if (!s) {
      s = await window.desk.createSession({ cwd: draftCwd, model: draftModel })
      setCurrent(s); currentRef.current = s
      setSessions(await window.desk.listSessions())
    }
    stick.current = true
    setItems((prev) => [...prev, { t: 'user', text }])
    setBusy(true)
    await window.desk.send(s.id, text)
  }

  const setModel = async (m: string) => {
    if (current) { await window.desk.setModel(current.id, m); setCurrent({ ...current, model: m }) }
    else setDraftModel(m)
  }

  const pickFolder = async () => { const f = await window.desk.pickFolder(); if (f) setDraftCwd(f) }
  const bg = runningBackground(items)
  const model = current?.model ?? draftModel
  const cwd = current?.cwd ?? draftCwd

  const composer = (
    <Composer busy={busy} model={model} models={models} cwd={cwd} onModel={setModel}
      onPickFolder={current ? undefined : pickFolder} onSend={send} onStop={() => current && window.desk.stop(current.id)} autoFocus />
  )

  return (
    <div className={`app ${sidebar ? '' : 'nosidebar'}`}>
      <aside className="sidebar">
        <div className="side-top">
          <button className="icon" title="Toggle sidebar" onClick={() => setSidebar(false)}>◧</button>
          <button className="icon" title="New chat" onClick={newChat}>✎</button>
        </div>
        <button className="new-chat" onClick={newChat}>＋ New chat</button>
        <div className="sessions">
          {sessions.map((s) => (
            <div key={s.id} className={`session ${current?.id === s.id ? 'on' : ''}`} onClick={() => open(s.id)}>
              <span className="dot" />
              <span className="title">{s.title}</span>
              <button className="del" title="Delete" onClick={(e) => { e.stopPropagation(); if (confirm('Delete this chat?')) { void window.desk.deleteSession(s.id); if (current?.id === s.id) newChat() } }}>×</button>
            </div>
          ))}
        </div>
        <div className="side-bottom">
          <span className="brand">AITM Desk</span>
          <button className="icon" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
        </div>
      </aside>

      <main className="main">
        {!sidebar && <button className="icon float-toggle" onClick={() => setSidebar(true)}>◧</button>}
        <div className="drag" />
        {!current && items.length === 0 ? (
          <div className="empty">
            <div className="logo">◆</div>
            <div className="wide">{composer}</div>
            {modelErr && <div className="err wide">Model provider unreachable: {modelErr} — check Settings.</div>}
            <div className="suggestions wide">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
            <div className="foot">AITM Desk uses AI. Check for mistakes.</div>
          </div>
        ) : (
          <>
            <div className="scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
              <div className="thread">
                <ItemList items={items} live={busy} />
                {busy && perms.length === 0 && asks.length === 0 && <div className="working"><span className="spinner" /> Working…</div>}
                {perms.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={(d) => { void window.desk.respondPermission(r.requestId, d); setPerms((x) => x.filter((y) => y.requestId !== r.requestId)) }} />)}
                {asks.map((r) => <AskCard key={r.requestId} req={r} onAnswer={(a) => { void window.desk.respondAsk(r.requestId, a); setAsks((x) => x.filter((y) => y.requestId !== r.requestId)); setItems((p) => [...p, { t: 'user', text: a }]) }} />)}
              </div>
            </div>
            <div className="bottom">
              {bg.length > 0 && <div className="tray">{bg.map((a) => <span key={a.agentId} className="chip"><span className="spinner" /> {a.name} · {a.agentId}</span>)}</div>}
              {composer}
            </div>
          </>
        )}
      </main>
      {showSettings && <SettingsModal cwd={cwd} onClose={() => { setShowSettings(false); void refreshModels() }} />}
    </div>
  )
}
