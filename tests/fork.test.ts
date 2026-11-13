import { describe, it, expect } from 'vitest'
import { sliceMessagesAtTurn, sliceItemsAtTurn, buildTree } from '../src/shared/fork'
import type { Message } from '../src/engine/types'

const msgs: Message[] = [
  { role: 'user', content: 'q0' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c', content: 'r' },
  { role: 'assistant', content: 'a0' },
  { role: 'user', content: '<system_notification>bg done</system_notification>' },
  { role: 'assistant', content: 'noted' },
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' }
]

describe('fork slicing', () => {
  it('keeps the whole chosen turn including notifications, and stops before the next real user turn', () => {
    expect(sliceMessagesAtTurn(msgs, 0).map((m) => m.content)).toEqual(['q0', null, 'r', 'a0', '<system_notification>bg done</system_notification>', 'noted'])
    expect(sliceMessagesAtTurn(msgs, 1)).toHaveLength(8)
  })
  it('slices UI items at user turns', () => {
    const items = [{ t: 'user' }, { t: 'tool' }, { t: 'assistant' }, { t: 'answer' }, { t: 'user' }, { t: 'assistant' }]
    expect(sliceItemsAtTurn(items, 0)).toHaveLength(4)
    expect(sliceItemsAtTurn(items, 1)).toHaveLength(6)
  })
})

describe('buildTree', () => {
  it('nests forks under parents and promotes orphans', () => {
    const t = buildTree([
      { id: 'a', parent_id: null }, { id: 'b', parent_id: 'a' }, { id: 'c', parent_id: 'b' }, { id: 'd', parent_id: 'gone' }
    ])
    expect(t.map((n) => n.row.id)).toEqual(['a', 'd'])
    expect(t[0].children[0].row.id).toBe('b')
    expect(t[0].children[0].children[0].row.id).toBe('c')
  })
})
