import type { Message } from '../engine/types'

const isRealUser = (m: Message) => m.role === 'user' && !m.content.startsWith('<system_notification>')

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

export interface TreeNode<T> { row: T; children: TreeNode<T>[] }

/** Builds a forest from rows with id/parent_id; orphans (missing parent) become roots. */
export function buildTree<T extends { id: string; parent_id: string | null }>(rows: T[]): TreeNode<T>[] {
  const nodes = new Map(rows.map((r) => [r.id, { row: r, children: [] as TreeNode<T>[] }]))
  const roots: TreeNode<T>[] = []
  for (const n of nodes.values()) {
    const p = n.row.parent_id ? nodes.get(n.row.parent_id) : undefined
    ;(p ? p.children : roots).push(n)
  }
  return roots
}
