import type { Message } from '../engine/types'

export const COMPACT_TAG = '<compacted_history>'
export const isRealUser = (m: Message) => m.role === 'user' && !m.content.startsWith('<system_notification>') && !m.content.startsWith(COMPACT_TAG)

/** Main-agent history up to and including user turn `turn` (0-based) and its full response. */
export function sliceMessagesAtTurn(messages: Message[], turn: number): Message[] {
  let seen = -1
  for (let i = 0; i < messages.length; i++) {
    if (isRealUser(messages[i]) && ++seen === turn + 1) return messages.slice(0, i)
  }
  return messages.slice()
}

/** UI items up to and including user turn `turn` (items with t === 'user' mark turn starts). */
export function sliceItemsAtTurn<T extends { t: string }>(items: T[], turn: number): T[] {
  let seen = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].t === 'user' && ++seen === turn + 1) return items.slice(0, i)
  }
  return items.slice()
}

/** Inserts `item` before the user item that starts UI turn `turn`; appends if that turn doesn't exist. */
export function insertBeforeTurn<T extends { t: string }>(items: T[], item: T, turn: number): T[] {
  let seen = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].t === 'user' && ++seen === turn) return [...items.slice(0, i), item, ...items.slice(i)]
  }
  return [...items, item]
}

export interface Orderable { sort_order?: number | null; updated_at?: number }

/** Display order: rows never arranged by the user (null sort_order) first, newest first; then manual order. */
export function orderRows<T extends Orderable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const an = a.sort_order == null, bn = b.sort_order == null
    if (an && bn) return (b.updated_at ?? 0) - (a.updated_at ?? 0)
    if (an) return -1
    if (bn) return 1
    return a.sort_order! - b.sort_order!
  })
}

/** Moves `id` one step (dir -1 up / +1 down) within `rows`; returns the new id order, or null if it can't move. */
export function moveInOrder<T extends Orderable & { id: string }>(rows: T[], id: string, dir: -1 | 1): string[] | null {
  const ids = orderRows(rows).map((r) => r.id)
  const i = ids.indexOf(id), j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return null
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  return ids
}

export interface TreeNode<T> { row: T; children: TreeNode<T>[] }

/** Builds a forest from rows with id/parent_id (siblings in display order); orphans (missing parent) become roots. */
export function buildTree<T extends { id: string; parent_id: string | null } & Orderable>(rows: T[]): TreeNode<T>[] {
  const nodes = new Map(orderRows(rows).map((r) => [r.id, { row: r, children: [] as TreeNode<T>[] }]))
  const roots: TreeNode<T>[] = []
  for (const n of nodes.values()) {
    const p = n.row.parent_id ? nodes.get(n.row.parent_id) : undefined
    ;(p ? p.children : roots).push(n)
  }
  return roots
}
