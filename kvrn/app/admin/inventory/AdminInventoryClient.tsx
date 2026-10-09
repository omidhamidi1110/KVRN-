'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminButton, AdminNotice, AdminField, AdminStat, AdminStatGrid,
  AdminTable, AdminTr, AdminTh, AdminTd, AdminEmpty, AdminLoading, AdminError, StatusBadge, AdminTag,
  adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

type Variant = {
  id: string; sku: string; size: string; color_name: string
  stock_on_hand: number; reserved_quantity: number; available_quantity: number
  active: boolean; product_name: string; updated_at: string
}
type Movement = { id: string; quantity_delta: number; movement_type: string; reason: string; note: string | null; actor_email: string; created_at: string }

export default function AdminInventoryClient() {
  const [variants, setVariants] = useState<Variant[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [form, setForm] = useState({ type: 'ADD', quantity: '', reason: '', note: '' })
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetch('/api/admin/inventory')
    if (!r.ok) { setError('Not authorised or failed to load.'); setLoading(false); return }
    const data = await r.json()
    setVariants(data.variants)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const loadMovements = async (variantId: string) => {
    const r = await fetch(`/api/admin/inventory/movements?variantId=${variantId}`)
    if (r.ok) setMovements((await r.json()).movements)
  }

  const selectVariant = (id: string) => { setSelected(id); loadMovements(id) }

  const submit = async () => {
    if (!selected || !form.reason.trim()) return
    const qty = parseInt(form.quantity, 10)
    if (isNaN(qty) || qty < 0) { setFeedback({ ok: false, msg: 'Invalid quantity.' }); return }
    setSubmitting(true)
    const r = await fetch('/api/admin/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: selected, type: form.type, quantity: qty, reason: form.reason, note: form.note }),
    })
    const data = await r.json()
    if (r.ok) {
      setFeedback({ ok: true, msg: 'Stock updated.' })
      setForm(f => ({ ...f, quantity: '', reason: '', note: '' }))
      await load(); await loadMovements(selected)
    } else {
      setFeedback({ ok: false, msg: data.error ?? 'Error.' })
    }
    setSubmitting(false)
  }

  const toggleActive = async (id: string, active: boolean) => {
    await fetch('/api/admin/inventory/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: id, active: !active }),
    })
    load()
  }

  if (loading) {
    return (
      <AdminPage>
        <AdminPageHeader title="Inventory" description="Stock, reservations, and availability." />
        <AdminLoading />
      </AdminPage>
    )
  }

  if (error) {
    return (
      <AdminPage>
        <AdminPageHeader title="Inventory" description="Stock, reservations, and availability." />
        <AdminError message={error} onRetry={load} />
      </AdminPage>
    )
  }

  const sel = variants.find(v => v.id === selected)

  const activeVariants = variants.filter(v => v.active)
  const availableUnits = activeVariants.reduce(
    (sum, v) => sum + Math.max(0, Number(v.available_quantity ?? 0)),
    0
  )
  const reservedUnits = activeVariants.reduce(
    (sum, v) => sum + Math.max(0, Number(v.reserved_quantity ?? 0)),
    0
  )
  const soldOutVariants = activeVariants.filter(
    v => Number(v.available_quantity ?? 0) <= 0
  ).length

  const onHandInfo = 'Units physically in stock.'
  const reservedInfo = 'Units held for checkouts in progress. They are not sold yet and are released if the checkout expires.'
  const availableInfo = 'On hand minus reserved. This is what can still be sold.'

  return (
    <AdminPage>
      <AdminPageHeader
        title="Inventory"
        description="Stock, reservations, and availability."
        actions={<AdminButton onClick={load}>Refresh</AdminButton>}
      />

      {/* Summary */}
      <AdminStatGrid min={170} className="mb-6">
        <AdminStat label="Variants" value={variants.length} sub={`${activeVariants.length} active`} />
        <AdminStat label="Available units" value={availableUnits} sub="Ready to sell" info={availableInfo} />
        <AdminStat label="Reserved" value={reservedUnits} sub="Held for checkout" info={reservedInfo} />
        <AdminStat label="Sold out" value={soldOutVariants} tone={soldOutVariants > 0 ? 'negative' : 'default'} sub="Active variants" />
      </AdminStatGrid>

      <div className="flex flex-col items-start gap-4 2xl:flex-col">

        {/* Inventory ledger */}
        <section className="w-full min-w-0 flex-1">
          <AdminSectionHeader title="Stock ledger" description="Select a variant to manage stock."
            actions={<AdminTag>{variants.length} variants</AdminTag>} />

          {variants.length === 0 ? (
            <AdminEmpty title="No inventory variants." />
          ) : (
            <div className="kv-inventory-table"><AdminTable stack minWidth={0} caption="Stock by variant">
              <thead>
                <AdminTr>
                  <AdminTh>Product</AdminTh>
                  <AdminTh>Size</AdminTh>
                  <AdminTh>SKU</AdminTh>
                  <AdminTh info={onHandInfo}>On hand</AdminTh>
                  <AdminTh info={reservedInfo}>Reserved</AdminTh>
                  <AdminTh info={availableInfo}>Available</AdminTh>
                  <AdminTh>Status</AdminTh>
                  <AdminTh>Updated</AdminTh>
                  <AdminTh><span className="sr-only">Manage</span></AdminTh>
                </AdminTr>
              </thead>
              <tbody>
                {variants.map(v => {
                  const available = Number(v.available_quantity)
                  const isSoldOut = v.active && available <= 0

                  return (
                    <AdminTr
                      key={v.id}
                      onClick={() => selectVariant(v.id)}
                      className={[
                        'cursor-pointer transition hover:bg-black/[0.018]',
                        selected === v.id ? 'bg-black/[0.03]' : '',
                      ].join(' ')}
                    >
                      <AdminTd label="Product" className="max-sm:!block max-sm:!text-left">
                        <p className="max-w-full break-words font-medium">{v.product_name}</p>
                        {v.color_name && <p className="mt-0.5 text-[11px] text-[#8A8A85]">{v.color_name}</p>}
                      </AdminTd>
                      <AdminTd label="Size" className="whitespace-nowrap text-[#4A4A46]">{v.size}</AdminTd>
                      <AdminTd label="SKU" className="min-w-0"><span className="break-all font-mono text-[10px] text-[#4A4A46]">{v.sku}</span></AdminTd>
                      <AdminTd label="On hand" className="font-medium">{v.stock_on_hand}</AdminTd>
                      <AdminTd label="Reserved" className="text-[#4A4A46]">{v.reserved_quantity}</AdminTd>
                      <AdminTd label="Available" className={['font-medium', available > 0 ? 'text-[#047857]' : 'text-[#B91C1C]'].join(' ')}>{available}</AdminTd>
                      <AdminTd label="Status">
                        <span className="flex flex-wrap items-center gap-1 max-sm:justify-end">
                          <StatusBadge status={v.active ? 'Active' : 'Inactive'} />
                          {isSoldOut && <AdminTag tone="danger">Sold out</AdminTag>}
                        </span>
                      </AdminTd>
                      <AdminTd label="Updated" className="text-[10px] text-[#6B6B66]">{new Date(v.updated_at).toLocaleString()}</AdminTd>
                      <AdminTd className="whitespace-nowrap text-right max-sm:!justify-end">
                        <AdminButton size="sm" variant="ghost" aria-label={`Manage ${v.sku}`}
                          onClick={e => { e.stopPropagation(); selectVariant(v.id) }}>Manage →</AdminButton>
                      </AdminTd>
                    </AdminTr>
                  )
                })}
              </tbody>
            </AdminTable></div>
          )}
        </section>

        {/* Variant management */}
        {sel && (
          <AdminCard padded={false} className="w-full flex-shrink-0 overflow-hidden 2xl:sticky 2xl:top-6 2xl:w-[410px]">
            <aside aria-label="Manage variant">
              <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#8A8A85]">Manage variant</p>
                  <h2 className="mt-1 truncate font-mono text-[12px] font-medium">{sel.sku}</h2>
                </div>

                <button
                  onClick={() => {
                    setSelected(null)
                    setMovements([])
                    setFeedback(null)
                  }}
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[9px] text-[#6B6B66] transition hover:bg-black/[0.05] hover:text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 sm:h-8 sm:w-8"
                  aria-label="Close variant"
                >
                  <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path d="M3 3l12 12M15 3 3 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>

              <div className="px-5 py-5">
                <div className="grid grid-cols-3 gap-2">
                  <AdminStat label="On hand" value={sel.stock_on_hand} info={onHandInfo} className="!px-3 !py-3" />
                  <AdminStat label="Reserved" value={sel.reserved_quantity} info={reservedInfo} className="!px-3 !py-3" />
                  <AdminStat label="Available" value={sel.available_quantity}
                    tone={Number(sel.available_quantity) > 0 ? 'positive' : 'negative'} info={availableInfo} className="!px-3 !py-3" />
                </div>

                <div className="mt-5">
                  <p className="mb-3 text-[12px] font-medium">Adjust inventory</p>

                  <div className="space-y-3">
                    <AdminField label="Action" htmlFor="inv-action">
                      <select
                        id="inv-action"
                        value={form.type}
                        onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                        className={adminSelectClass}
                      >
                        <option value="ADD">Add stock</option>
                        <option value="REMOVE">Remove stock</option>
                        <option value="SET">Set absolute quantity</option>
                      </select>
                    </AdminField>

                    <AdminField label="Quantity *" htmlFor="inv-qty">
                      <input
                        id="inv-qty"
                        type="number"
                        min={0}
                        value={form.quantity}
                        onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                        className={adminInputClass}
                      />
                    </AdminField>

                    <AdminField label="Reason *" htmlFor="inv-reason">
                      <input
                        id="inv-reason"
                        type="text"
                        value={form.reason}
                        onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                        placeholder="e.g. Initial stock entry"
                        className={adminInputClass}
                      />
                    </AdminField>

                    <AdminField label="Note (optional)" htmlFor="inv-note">
                      <input
                        id="inv-note"
                        type="text"
                        value={form.note}
                        onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                        className={adminInputClass}
                      />
                    </AdminField>

                    <AdminButton
                      variant="primary"
                      className="w-full"
                      onClick={submit}
                      disabled={submitting || !form.reason.trim() || form.quantity === ''}
                    >
                      {submitting ? 'Saving…' : 'Save adjustment'}
                    </AdminButton>
                  </div>
                </div>

                {feedback && (
                  <AdminNotice tone={feedback.ok ? 'success' : 'danger'} className="mt-4">{feedback.msg}</AdminNotice>
                )}

                <div className="mt-5 border-t border-black/[0.06] pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-medium">Availability</p>
                      <p className="mt-0.5 text-[11px] text-[#6B6B66]">
                        {sel.active ? 'Variant is active.' : 'Variant is inactive.'}
                      </p>
                    </div>

                    <AdminButton
                      variant={sel.active ? 'danger' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        if (confirm(`${sel.active ? 'Deactivate' : 'Activate'} ${sel.sku}?`)) {
                          toggleActive(sel.id, sel.active)
                        }
                      }}
                    >
                      {sel.active ? 'Deactivate' : 'Activate'}
                    </AdminButton>
                  </div>
                </div>

                <div className="mt-5 border-t border-black/[0.06] pt-5">
                  <p className="mb-3 text-[12px] font-medium">Recent movements</p>

                  {movements.length === 0 ? (
                    <p className="rounded-[10px] bg-[#F8F8F6] px-3 py-5 text-center text-[11px] text-[#6B6B66]">No movements yet.</p>
                  ) : (
                    <div className="max-h-[300px] space-y-2 overflow-y-auto">
                      {movements.map(m => (
                        <div key={m.id} className="rounded-[10px] border border-black/[0.06] bg-[#FAFAF8] p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[12px] font-medium text-[#171717]">{m.reason}</p>
                              <p className="mt-0.5 text-[11px] text-[#6B6B66]">
                                {m.movement_type} · {new Date(m.created_at).toLocaleString()}
                              </p>
                            </div>

                            <span className={[
                              'flex-shrink-0 text-[12px] font-semibold',
                              m.quantity_delta >= 0 ? 'text-[#047857]' : 'text-[#B91C1C]',
                            ].join(' ')}>
                              {m.quantity_delta >= 0 ? '+' : ''}{m.quantity_delta}
                            </span>
                          </div>

                          {m.note && <p className="mt-2 text-[11px] leading-4 text-[#4A4A46]">{m.note}</p>}

                          <p className="mt-2 truncate text-[11px] text-[#8A8A85]">{m.actor_email}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </AdminCard>
        )}
      </div>
    </AdminPage>
  )
}
