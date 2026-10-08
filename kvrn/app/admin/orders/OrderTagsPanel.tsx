'use client'
// Internal tags for one order: create / select / remove. Tags are INTERNAL labels — never shown to customers,
// never change payment, stock or fulfillment. A tag named "Hold" is just a label; the fraud hold is separate.

import { useEffect, useMemo, useState } from 'react'
import { AdminSectionHeader, AdminButton, AdminNotice, InfoTip, adminInputClass } from '@/components/admin/ui/AdminUI'
import { ORDER_TAG_COLORS, ORDER_TAG_NAME_MAX, type OrderTag, type OrderTagChip } from '@/lib/order-tags'
import { tagChipClass } from './orders-ui'

export function TagChip({ tag, onRemove, disabled }: { tag: OrderTagChip; onRemove?: () => void; disabled?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] font-medium ${tagChipClass(tag.color)}`}>
      {tag.name}
      {onRemove && (
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove tag ${tag.name}`}
          className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-black/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 disabled:opacity-40">
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      )}
    </span>
  )
}

export function OrderTagsPanel({
  orderId, tags, allTags, onChanged, onTagsCatalogChanged,
}: {
  orderId: string
  tags: OrderTagChip[]
  allTags: OrderTag[]
  /** New chip list for this order after an add/remove. */
  onChanged: (tags: OrderTagChip[]) => void
  /** The catalog (create / archive / delete) changed: reload it. */
  onTagsCatalogChanged: () => void
}) {
  const [pick, setPick] = useState('')
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>('neutral')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setPick(''); setNewName(''); setErr(null) }, [orderId])

  const available = useMemo(
    () => allTags.filter(t => !t.archived && !tags.some(x => x.id === t.id)),
    [allTags, tags])

  async function call(url: string, init: RequestInit) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(url, init)
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Failed.'); return null }
      return json
    } catch { setErr('Network error.'); return null } finally { setBusy(false) }
  }

  async function add(tagId: string) {
    const j = await call(`/api/admin/orders/${orderId}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagId }),
    })
    if (j) { onChanged(j.data); setPick('') }
  }
  async function remove(tagId: string) {
    const j = await call(`/api/admin/orders/${orderId}/tags?tagId=${encodeURIComponent(tagId)}`, { method: 'DELETE' })
    if (j) onChanged(j.data)
  }
  async function createAndAdd() {
    const name = newName.trim()
    if (!name) return
    const c = await call('/api/admin/orders/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: newColor }),
    })
    if (!c) return
    setNewName('')
    onTagsCatalogChanged()
    await add(c.data.id)
  }

  return (
    <section aria-label="Order tags">
      <AdminSectionHeader
        title="Tags"
        info={<>Internal labels for your own organization. They are never shown to customers and never change payment, stock or fulfillment. A “Hold” tag does not block anything — fraud holds are separate.</>}
      />
      <div className="mb-2 flex flex-wrap gap-1.5">
        {tags.length === 0 && <span className="text-[12px] text-[#8A8A85]">No tags.</span>}
        {tags.map(t => <TagChip key={t.id} tag={t} onRemove={() => remove(t.id)} disabled={busy} />)}
      </div>
      <div className="flex gap-2">
        <select aria-label="Add a tag" value={pick} onChange={e => { setPick(e.target.value); if (e.target.value) add(e.target.value) }}
          disabled={busy || available.length === 0} className={adminInputClass}>
          <option value="">{available.length === 0 ? 'No more tags' : 'Add a tag…'}</option>
          {available.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <details className="mt-2 text-[12px]">
        <summary className="cursor-pointer select-none py-1 text-[#6B6B66]">New tag</summary>
        <div className="mt-1 flex flex-wrap gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} maxLength={ORDER_TAG_NAME_MAX} aria-label="New tag name"
            placeholder="Tag name" onKeyDown={e => e.key === 'Enter' && createAndAdd()} className={`${adminInputClass} min-w-[120px] flex-1`} />
          <select aria-label="Tag color" value={newColor} onChange={e => setNewColor(e.target.value)} className={`${adminInputClass} w-[96px]`}>
            {ORDER_TAG_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <AdminButton onClick={createAndAdd} disabled={busy || !newName.trim()}>Create &amp; add</AdminButton>
        </div>
      </details>
      {err && <AdminNotice tone="danger" className="mt-2">{err}</AdminNotice>}
    </section>
  )
}

/** Compact catalog manager: archive / restore / delete (unused only). Shown on the Orders page filter bar. */
export function ManageTags({ tags, onChanged }: { tags: OrderTag[]; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(url: string, init: RequestInit, ok: string) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(url, init)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(json.error ?? 'Failed.'); return }
      void ok
      onChanged()
    } catch { setErr('Network error.') } finally { setBusy(false) }
  }

  if (tags.length === 0) return null
  return (
    <details className="text-[12px]">
      <summary className="cursor-pointer select-none py-1 text-[#6B6B66]">Manage tags</summary>
      <ul className="mt-1 divide-y divide-black/[0.06] rounded-[10px] border border-black/[0.08] bg-white">
        {tags.map(t => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
            <span className="flex items-center gap-2">
              <TagChip tag={t} />
              <span className="text-[11px] text-[#8A8A85]">{t.archived ? 'Archived · ' : ''}{t.orderCount ?? 0} order{(t.orderCount ?? 0) === 1 ? '' : 's'}</span>
            </span>
            <span className="flex gap-1.5">
              <AdminButton size="sm" variant="ghost" disabled={busy}
                onClick={() => run(`/api/admin/orders/tags/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: !t.archived }) }, '')}>
                {t.archived ? 'Restore' : 'Archive'}
              </AdminButton>
              {(t.orderCount ?? 0) === 0 && (
                <AdminButton size="sm" variant="danger" disabled={busy}
                  onClick={() => { if (window.confirm(`Delete the tag “${t.name}”? This cannot be undone.`)) run(`/api/admin/orders/tags/${t.id}`, { method: 'DELETE' }, '') }}>
                  Delete
                </AdminButton>
              )}
            </span>
          </li>
        ))}
      </ul>
      {err && <AdminNotice tone="danger" className="mt-2">{err}</AdminNotice>}
    </details>
  )
}
