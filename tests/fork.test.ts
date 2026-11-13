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

import { orderRows, reorderIds, isWithin, insertBeforeTurn, liveTurnMap } from '../src/shared/fork'
describe('ordering', () => {
  const rows = [{ id: 'a', updated_at: 1, sort_order: null }, { id: 'b', updated_at: 3, sort_order: null }, { id: 'c', updated_at: 9, sort_order: 0 }, { id: 'd', updated_at: 2, sort_order: 1 }]
  it('puts un-arranged rows first (newest first) then manual order', () => {
    expect(orderRows(rows).map((r) => r.id)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('reorders an id before/after a target, or appends', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c'])
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderIds(['a', 'b'], 'x', null, true)).toEqual(['a', 'b', 'x'])
    expect(reorderIds(['a', 'b'], 'x', 'a', true)).toEqual(['x', 'a', 'b'])
  })
  it('detects a node inside its own subtree (to block folder cycles)', () => {
    const t = [{ id: 'f1', parent_id: null }, { id: 'f2', parent_id: 'f1' }, { id: 'f3', parent_id: 'f2' }, { id: 'g', parent_id: null }]
    expect(isWithin(t, 'f1', 'f3')).toBe(true)
    expect(isWithin(t, 'f1', 'f1')).toBe(true)
    expect(isWithin(t, 'f2', 'g')).toBe(false)
    expect(isWithin(t, 'f1', null)).toBe(false)
  })
  it('inserts an item before a given UI turn', () => {
    const items = [{ t: 'user' }, { t: 'assistant' }, { t: 'user' }, { t: 'assistant' }]
    expect(insertBeforeTurn(items, { t: 'x' }, 1).map((i) => i.t)).toEqual(['user', 'assistant', 'x', 'user', 'assistant'])
  })
})

describe('live turn map', () => {
  it('maps live turns to UI turns, extending past the stored map', () => {
    expect(liveTurnMap(3, null)).toEqual([0, 1, 2])
    expect(liveTurnMap(3, null, 4)).toEqual([4, 5, 6])
    expect(liveTurnMap(4, [1, 4], 0)).toEqual([1, 4, 5, 6])
    expect(liveTurnMap(1, [], 0)).toEqual([0])
  })
})
