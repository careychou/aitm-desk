import { useState } from 'react'
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
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="reasoning">
      <button onClick={() => setOpen(!open)}>{live ? 'Thinking…' : 'Thought process'} {open ? '▾' : '▸'}</button>
      {open && <div className="reasoning-body">{text}</div>}
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
          case 'user': return <div className="msg user"><div className="bubble">{it.text}</div></div>
          case 'answer': return <div className="msg user"><div className="bubble answer">{it.text}</div></div>
          case 'assistant':
            return (
              <div className={`msg assistant ${it.agentId === 'main' ? '' : 'sub'}`}>
                <Reasoning text={it.reasoning} live={live && isLast && !it.text} />
                {it.text && <Markdown text={it.text} />}
              </div>
            )
          case 'tool': return <ToolCard it={it} />
          case 'agent': return <AgentCard it={it} />
          case 'error': return <div className="err">{it.text}</div>
        } })()
        return <div key={i} className="item">{el}{forkBtn}</div>
      })}
    </>
  )
}
