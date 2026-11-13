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

/**
 * UI turn index (0-based, as shown in the chat) for each of the `count` turns still in the live history.
 * `map` is stored after compactions (kept turns may be non-contiguous); turns added later continue after its last entry.
 * `offset` is the legacy form (all turns before it were compacted).
 */
export function liveTurnMap(count: number, map: number[] | null, offset = 0): number[] {
  const m = map ?? []
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(i < m.length ? m[i] : m.length ? m[m.length - 1] + (i - m.length + 1) : i + offset)
  return out
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

/** Returns `ids` with `id` moved before/after `targetId` (appended when targetId is null or missing). `id` may be absent from `ids`. */
export function reorderIds(ids: string[], id: string, targetId: string | null, before: boolean): string[] {
  const out = ids.filter((x) => x !== id)
  const t = targetId ? out.indexOf(targetId) : -1
  if (t < 0) out.push(id)
  else out.splice(before ? t : t + 1, 0, id)
  return out
}

/** True if `id` is `ancestorId` or nested anywhere under it (via parent_id). */
export function isWithin<T extends { id: string; parent_id: string | null }>(rows: T[], ancestorId: string, id: string | null): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (let cur = id, n = 0; cur && n < 1000; n++) {
    if (cur === ancestorId) return true
    cur = byId.get(cur)?.parent_id ?? null
  }
  return false
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
