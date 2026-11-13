import { useEffect, useRef, useState } from 'react'
import type { Item } from '../state'
import { Markdown } from '../Markdown'

function summarize(name: string, args: string): string {
  try {
    const a = JSON.parse(args)
    const v = a.command ?? a.path ?? a.pattern ?? a.name ?? a.agent_id ?? a.question ?? ''
    return String(v).replace(/\s+/g, ' ').slice(0, 120)
  } catch { return args.slice(0, 120) }
}

const ICON: Record<string, string> = { shell: '⌘', read_file: '📄', write_file: '✎', edit_file: '✎', glob: '🔎', grep: '🔎', skill: '✦', read_agent: '⇠', list_agents: '☰', ask_user: '?' }

export function ToolCard({ it }: { it: Extract<Item, { t: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const state = it.output === undefined ? 'running' : it.ok ? 'ok' : 'fail'
  return (
    <div className={`tool ${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{ICON[it.name] ?? '•'}</span>
        <span className="tool-name">{it.name}</span>
        <span className="tool-sum">{summarize(it.name, it.args)}</span>
        <span className="tool-state">{state === 'running' ? <span className="spinner" /> : state === 'ok' ? '✓' : '✗'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <pre>{prettyArgs(it.args)}</pre>
          {it.output !== undefined && (<><div className="label">Output</div><pre>{it.output}</pre></>)}
        </div>
      )}
    </div>
  )
}

function prettyArgs(a: string) { try { return JSON.stringify(JSON.parse(a), null, 2) } catch { return a } }

export function Reasoning({ text, live }: { text: string; live: boolean }) {
  // Copilot-style: open while the model is thinking, collapse once it moves on; the user can toggle anytime
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? live
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { if (live && body.current) body.current.scrollTop = body.current.scrollHeight }, [text, live])
  if (!text.trim()) return null
  const firstLine = text.trim().split('\n')[0].replace(/[*#]/g, '').slice(0, 90)
  return (
    <div className={`reasoning ${live ? 'live' : ''}`}>
      <button className="reasoning-head" onClick={() => setManual(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="reasoning-label">{live ? 'Thinking' : 'Thought'}</span>
        {live && <span className="dots"><i /><i /><i /></span>}
        {!open && <span className="reasoning-peek">{firstLine}</span>}
      </button>
      {open && <div ref={body} className="reasoning-body"><Markdown text={text} /></div>}
    </div>
  )
}

export function AgentCard({ it }: { it: Extract<Item, { t: 'agent' }> }) {
  const [open, setOpen] = useState(true)
  const running = it.status === 'running'
  return (
    <div className={`agent ${it.status}`}>
      <button className="agent-head" onClick={() => setOpen(!open)}>
        <span className="agent-badge">{it.mode === 'background' ? 'BG' : 'SUB'}</span>
        <span className="agent-name">{it.name}</span>
        <span className="agent-sum">{it.prompt.replace(/\s+/g, ' ').slice(0, 90)}</span>
        <span className="agent-status">{running ? <span className="spinner" /> : it.status}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="agent-body">
          <ItemList items={it.children} live={running} />
          {!running && it.finalText && it.status !== 'completed' && <div className="err">{it.finalText}</div>}
        </div>
      )}
    </div>
  )
}

function CompactMarker({ it }: { it: Extract<Item, { t: 'compact' }> }) {
  const [open, setOpen] = useState(false)
  const k = (n: number) => `${Math.round(n / 1000)}k`
  return (
    <div className="compact-marker">
      <button onClick={() => setOpen(!open)}>
        <span className="line" /><span className="lbl">⇲ {it.auto ? 'Auto-compacted' : 'Compacted'}: {it.summarized} turn(s) summarized{it.dropped ? `, ${it.dropped} dropped` : ''} · ~{k(it.before)} → ~{k(it.after)} tokens {open ? '▾' : '▸'}</span><span className="line" />
      </button>
      {open && (
        <div className="compact-summary">
          {it.keptTurns && <div className="muted">Kept word-for-word: {it.keptTurns.length ? `turns ${it.keptTurns.join(', ')}` : 'none'} · Summarized: {it.summarizedTurns?.length ? it.summarizedTurns.join(', ') : 'none'} · Dropped: {it.droppedTurns?.length ? it.droppedTurns.join(', ') : 'none'}</div>}
          <div className="muted">Summary the agent now carries:</div>
          <Markdown text={it.summary} />
        </div>
      )}
    </div>
  )
}

export function ItemList({ items, live, onFork }: { items: Item[]; live: boolean; onFork?: (turn: number) => void }) {
  let turn = -1
  // the fork button for turn N sits at the end of turn N (just before the next user message, or at the end)
  const turnEnds = new Map<number, number>()
  items.forEach((it, i) => { if (it.t === 'user') { turn++ } turnEnds.set(turn, i) })
  turn = -1
  return (
    <>
      {items.map((it, i) => {
        const isLast = i === items.length - 1
        if (it.t === 'user') turn++
        const t = turn
        const forkBtn = onFork && t >= 0 && turnEnds.get(t) === i && !(live && isLast)
          ? <div className="turn-actions"><button onClick={() => onFork(t)} title="Fork a new chat from this point; it is filed under this chat">⑂ Fork from here</button></div>
          : null
        const el = (() => { switch (it.t) {
          case 'user': return (
            <div className="msg user">
              {it.attachments?.length ? <div className="atts">{it.attachments.map((a, k) => (
                <div key={k} className="att-chip" title={`${a.name}\n${a.info}`}>
                  {a.thumb ? <img src={a.thumb} alt="" /> : <span className="att-ico">📄</span>}
                  <span className="att-text"><span className="att-name">{a.name}</span><span className="att-info">{a.info}</span></span>
                </div>))}</div> : null}
              {it.text && <div className="bubble">{it.text}</div>}
            </div>)
          case 'answer': return <div className="msg user"><div className="bubble answer">{it.text}</div></div>
          case 'assistant':
            return (
              <div className={`msg assistant ${it.agentId === 'main' ? '' : 'sub'}`}>
                <Reasoning text={it.reasoning} live={live && isLast && !it.text && !it.closed} />
                {it.text && <Markdown text={it.text} />}
              </div>
            )
          case 'tool': return <ToolCard it={it} />
          case 'agent': return <AgentCard it={it} />
          case 'error': return <div className="err">{it.text}</div>
          case 'compact': return <CompactMarker it={it} />
        } })()
        return <div key={i} className="item">{el}{forkBtn}</div>
      })}
    </>
  )
}
