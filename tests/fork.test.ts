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

import { orderRows, moveInOrder, insertBeforeTurn } from '../src/shared/fork'
describe('ordering', () => {
  const rows = [{ id: 'a', updated_at: 1, sort_order: null }, { id: 'b', updated_at: 3, sort_order: null }, { id: 'c', updated_at: 9, sort_order: 0 }, { id: 'd', updated_at: 2, sort_order: 1 }]
  it('puts un-arranged rows first (newest first) then manual order', () => {
    expect(orderRows(rows).map((r) => r.id)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('moves within siblings and refuses past the ends', () => {
    expect(moveInOrder(rows, 'c', -1)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveInOrder(rows, 'b', -1)).toBeNull()
    expect(moveInOrder(rows, 'd', 1)).toBeNull()
  })
  it('inserts an item before a given UI turn', () => {
    const items = [{ t: 'user' }, { t: 'assistant' }, { t: 'user' }, { t: 'assistant' }]
    expect(insertBeforeTurn(items, { t: 'x' }, 1).map((i) => i.t)).toEqual(['user', 'assistant', 'x', 'user', 'assistant'])
  })
})
