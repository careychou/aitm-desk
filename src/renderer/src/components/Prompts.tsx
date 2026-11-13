import { useState } from 'react'
import type { PermissionDecision } from '../../../shared/api'

export interface PermissionReq { requestId: string; agentId: string; kind: string; detail: string }
export interface AskReq { requestId: string; agentId: string; question: string; choices?: string[] }

export function PermissionCard({ req, onDecide }: { req: PermissionReq; onDecide(d: PermissionDecision): void }) {
  return (
    <div className="prompt-card">
      <div className="prompt-title">{req.kind === 'shell' ? 'Run this command?' : 'Allow this file change?'} {req.agentId !== 'main' && <span className="muted">· {req.agentId}</span>}</div>
      <pre>{req.detail}</pre>
      <div className="prompt-actions">
        <button className="primary" onClick={() => onDecide('allow')}>Allow</button>
        <button onClick={() => onDecide('allow_session')}>Allow all {req.kind} this session</button>
        <button className="danger" onClick={() => onDecide('deny')}>Deny</button>
      </div>
    </div>
  )
}

export function AskCard({ req, onAnswer }: { req: AskReq; onAnswer(a: string): void }) {
  const [txt, setTxt] = useState('')
  return (
    <div className="prompt-card">
      <div className="prompt-title">{req.question}</div>
      {req.choices?.length ? <div className="choices">{req.choices.map((c) => <button key={c} onClick={() => onAnswer(c)}>{c}</button>)}</div> : null}
      <div className="ask-row">
        <input value={txt} placeholder="Type an answer…" onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && txt.trim()) onAnswer(txt.trim()) }} />
        <button className="primary" disabled={!txt.trim()} onClick={() => onAnswer(txt.trim())}>Send</button>
      </div>
    </div>
  )
}
