import { useEffect } from 'react'

export type MenuEntry = { label: string; onClick(): void; danger?: boolean; disabled?: boolean } | 'sep'
export interface MenuState { x: number; y: number; items: MenuEntry[] }

export function Menu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const top = Math.min(menu.y, window.innerHeight - 24 - menu.items.length * 30)
  return (
    <div className="menu-back" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div className="menu" style={{ left: menu.x, top }} onClick={(e) => e.stopPropagation()}>
        {menu.items.map((it, i) => it === 'sep'
          ? <div key={i} className="menu-sep" />
          : <button key={i} className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { onClose(); it.onClick() }}>{it.label}</button>)}
      </div>
    </div>
  )
}

/** Opens a menu anchored at a mouse event (button click or right-click). */
export const at = (e: React.MouseEvent, items: MenuEntry[]): MenuState => {
  e.preventDefault(); e.stopPropagation()
  return { x: Math.min(e.clientX, window.innerWidth - 230), y: e.clientY + 4, items }
}
