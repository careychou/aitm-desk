import { useEffect, useRef, useState } from 'react'
import type { Item } from '../state'
import { Markdown } from '../Markdown'

type ToolItem = Extract<Item, { t: 'tool' }>

const parse = (args: string): Record<string, any> => { try { return JSON.parse(args) ?? {} } catch { return {} } }
const q = (v: unknown, n = 60) => { const s = String(v ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shortUrl = (u: string) => { try { const x = new URL(u); return q(x.host + x.pathname, 70) } catch { return q(u, 70) } }

/** Human description of a tool call, Copilot-style ("Run unit tests", "Edit src/app.ts"). */
export function toolLabel(name: string, args: string): string {
  const a = parse(args)
  switch (name) {
    case 'shell': return q(a.description, 80) || `Run \`${q(a.command, 60)}\``
    case 'read_shell': return `Read output of ${a.shellId}`
    case 'write_shell': return `Send input to ${a.shellId}`
    case 'stop_shell': return `Stop ${a.shellId}`
    case 'list_shells': return 'List background shells'
    case 'read_file': return `View ${q(a.path, 80)}${a.start ? ` (lines ${a.start}–${a.end ?? 'end'})` : ''}`
    case 'write_file': return `Create ${q(a.path, 80)}`
    case 'edit_file': return `Edit ${q(a.path, 80)}`
    case 'glob': return `Find files matching ${q(a.pattern)}`
    case 'grep': return `Search for "${q(a.pattern, 50)}"${a.path ? ` in ${q(a.path, 40)}` : ''}`
    case 'web_fetch': return `Fetch ${shortUrl(String(a.url ?? ''))}`
    case 'sql': return q(a.description, 60) || `Run SQL: ${q(a.query, 50)}`
    case 'skill': return `Load skill ${a.name ?? ''}`
    case 'ask_user': return `Ask: ${q(a.question, 70)}`
    case 'read_agent': return `Read sub-agent ${a.agent_id ?? ''}`
    case 'list_agents': return 'List sub-agents'
    default: return name
  }
}

const toolState = (it: ToolItem) => (it.output === undefined ? 'running' : it.ok ? 'ok' : 'fail')
const StateMark = ({ s }: { s: string }) => (s === 'running' ? <span className="spinner" /> : s === 'fail' ? <span className="tool-x">✗</span> : null)

function ToolDetail({ it }: { it: ToolItem }) {
  const a = parse(it.args)
  if (it.name === 'shell' || it.name === 'write_shell') {
    const cmd = it.name === 'shell' ? a.command : `${a.shellId} ← ${JSON.stringify(a.input)}`
    return <pre className="term"><span className="term-cmd">$ {cmd}</span>{it.output !== undefined ? `\n\n${it.output.trim()}` : ''}</pre>
  }
  if (it.name === 'sql') return <><pre className="term"><span className="term-cmd">{a.query}</span></pre>{it.output !== undefined && <div className="tool-out"><Markdown text={it.output} /></div>}</>
  if (it.name === 'edit_file') return <><pre className="term diff"><span className="del">{String(a.old_str ?? '').split('\n').map((l) => `- ${l}`).join('\n')}</span>{'\n'}<span className="add">{String(a.new_str ?? '').split('\n').map((l) => `+ ${l}`).join('\n')}</span></pre>{it.ok === false && <pre className="term">{it.output}</pre>}</>
  if (it.name === 'write_file') return <><pre className="term">{String(a.content ?? '').slice(0, 20000)}</pre>{it.ok === false && <pre className="term">{it.output}</pre>}</>
  return <>{Object.keys(a).length > 1 && <pre className="term">{prettyArgs(it.args)}</pre>}{it.output !== undefined && <pre className="term">{it.output}</pre>}</>
}

/** One tool call: a description row that expands to the command/output. */
export function ToolCard({ it }: { it: ToolItem }) {
  const [open, setOpen] = useState(false)
  const state = toolState(it)
  return (
    <div className={`tool ${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '›'}</span>
        <span className="tool-sum">{toolLabel(it.name, it.args)}</span>
        <StateMark s={state} />
      </button>
      {open && <div className="tool-body"><ToolDetail it={it} /></div>}
    </div>
  )
}

/** Consecutive tool calls collapse into one row: "Run tests and 3 other tool calls". */
function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) return <ToolCard it={tools[0]} />
  const running = tools.find((t) => toolState(t) === 'running')
  const failed = tools.filter((t) => toolState(t) === 'fail').length
  const lead = running ?? tools[0]
  const others = tools.length - 1
  return (
    <div className={`tool-group ${running ? 'running' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '›'}</span>
        <span className="tool-sum">{toolLabel(lead.name, lead.args)} <span className="muted">and {others} other tool call{others > 1 ? 's' : ''}</span></span>
        {running ? <span className="spinner" /> : failed ? <span className="tool-x" title={`${failed} failed`}>✗ {failed}</span> : null}
      </button>
      {open && <div className="tool-group-body">{tools.map((t) => <ToolCard key={t.callId} it={t} />)}</div>}
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
        <span className="line" /><span className="lbl">⇲ {it.auto ? 'Auto-compacted' : 'Compacted'}: {it.summarized} turn(s) summarized{it.dropped ? `, ${it.dropped} dropped` : ''} · ~{k(it.before)} → ~{k(it.after)} tokens{it.model ? ` · by ${it.model.split('::').pop()!.split('/').pop()}` : ''} {open ? '▾' : '▸'}</span><span className="line" />
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

type Seg = { i: number; end: number; tools?: ToolItem[] }

/** Folds runs of tool calls (and the empty assistant steps between them) into groups. */
function segments(items: Item[]): Seg[] {
  const out: Seg[] = []
  const blank = (it: Item) => it.t === 'assistant' && !it.text.trim() && !it.reasoning.trim()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const g = out[out.length - 1]
    if (it.t === 'tool') {
      if (g?.tools && g.end === i - 1) { g.tools.push(it); g.end = i } else out.push({ i, end: i, tools: [it] })
    } else if (blank(it) && g?.tools && g.end === i - 1 && items[i + 1]?.t === 'tool') g.end = i
    else out.push({ i, end: i })
  }
  return out
}

export function ItemList({ items, live, onFork }: { items: Item[]; live: boolean; onFork?: (turn: number) => void }) {
  // the fork button for turn N sits at the end of turn N (just before the next user message, or at the end)
  const turnOf: number[] = []
  const turnEnds = new Map<number, number>()
  let turn = -1
  items.forEach((it, i) => { if (it.t === 'user') turn++; turnOf[i] = turn; turnEnds.set(turn, i) })
  return (
    <>
      {segments(items).map((sg) => {
        const isLast = sg.end === items.length - 1
        const t = turnOf[sg.end]
        const forkBtn = onFork && t >= 0 && turnEnds.get(t) === sg.end && !(live && isLast)
          ? <div className="turn-actions"><button onClick={() => onFork(t)} title="Fork a new chat from this point; it is filed under this chat">⑂ Fork from here</button></div>
          : null
        if (sg.tools) return <div key={sg.i} className="item"><ToolGroup tools={sg.tools} />{forkBtn}</div>
        const it = items[sg.i]
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
            if (!it.text.trim() && !it.reasoning.trim()) return null
            return (
              <div className={`msg assistant ${it.agentId === 'main' ? '' : 'sub'}`}>
                <Reasoning text={it.reasoning} live={live && isLast && !it.text && !it.closed} />
                {it.text && <Markdown text={it.text} />}
              </div>
            )
          case 'tool': return null
          case 'agent': return <AgentCard it={it} />
          case 'error': return <div className="err">{it.text}</div>
          case 'compact': return <CompactMarker it={it} />
        } })()
        return <div key={sg.i} className="item">{el}{forkBtn}</div>
      })}
    </>
  )
}
