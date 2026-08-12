'use client'
import { useState, useEffect, useCallback } from 'react'

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
      <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
        <div className="animate-pulse">
          <div className="h-8 w-48 rounded bg-black/10" />
          <div className="mt-3 h-4 w-72 rounded bg-black/[0.06]" />
          <div className="mt-8 h-[420px] rounded-xl border border-black/[0.06] bg-white" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
          {error}
        </div>
      </div>
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

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">

      {/* Page header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">
            Operations
          </p>
          <h1 className="text-[30px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[34px]">
            Inventory
          </h1>
          <p className="mt-2 text-[13px] text-black/45">
            Manage variant availability, stock levels, reservations, and inventory history.
          </p>
        </div>

        <button
          onClick={load}
          className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-lg border border-black/[0.10] bg-white px-4 text-[11px] font-medium text-black/55 shadow-sm transition hover:border-black/20 hover:text-black sm:self-auto"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Refresh
        </button>
      </div>

      {/* Summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="rounded-xl border border-black/[0.07] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-5">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-black/30">
            Variants
          </p>
          <p className="mt-3 text-[25px] font-medium tracking-[-0.04em]">
            {variants.length}
          </p>
          <p className="mt-1 text-[10px] text-black/30">
            {activeVariants.length} active
          </p>
        </div>

        <div className="rounded-xl border border-black/[0.07] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-5">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-black/30">
            Available units
          </p>
          <p className="mt-3 text-[25px] font-medium tracking-[-0.04em]">
            {availableUnits}
          </p>
          <p className="mt-1 text-[10px] text-black/30">Ready to sell</p>
        </div>

        <div className="rounded-xl border border-black/[0.07] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-5">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-black/30">
            Reserved
          </p>
          <p className="mt-3 text-[25px] font-medium tracking-[-0.04em]">
            {reservedUnits}
          </p>
          <p className="mt-1 text-[10px] text-black/30">Held for checkout</p>
        </div>

        <div className="rounded-xl border border-black/[0.07] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-5">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-black/30">
            Sold out
          </p>
          <p className={[
            'mt-3 text-[25px] font-medium tracking-[-0.04em]',
            soldOutVariants > 0 ? 'text-red-600' : 'text-[#171717]',
          ].join(' ')}>
            {soldOutVariants}
          </p>
          <p className="mt-1 text-[10px] text-black/30">Active variants</p>
        </div>
      </div>

      <div className="flex flex-col items-start gap-4 2xl:flex-row">

        {/* Inventory ledger */}
        <section className="w-full min-w-0 flex-1 overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-black/30">
                Stock ledger
              </p>
              <p className="mt-1 text-[12px] text-black/40">
                Select a variant to manage stock
              </p>
            </div>

            <span className="rounded-full border border-black/[0.07] px-3 py-1 text-[10px] font-medium text-black/35">
              {variants.length} variants
            </span>
          </div>

          {variants.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-[13px] font-medium text-black/55">No inventory variants</p>
              <p className="mt-1 text-[11px] text-black/30">
                Inventory will appear here once variants are created.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-[#FAFAF9]">
                    {['Product','Size','SKU','On Hand','Reserved','Available','Status','Updated',''].map(h => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-4 py-3 text-[9px] font-medium uppercase tracking-[0.12em] text-black/30"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {variants.map(v => {
                    const available = Number(v.available_quantity)
                    const isSoldOut = v.active && available <= 0

                    return (
                      <tr
                        key={v.id}
                        onClick={() => selectVariant(v.id)}
                        className={[
                          'cursor-pointer border-b border-black/[0.05] transition last:border-0 hover:bg-black/[0.018]',
                          selected === v.id ? 'bg-black/[0.025]' : '',
                        ].join(' ')}
                      >
                        <td className="px-4 py-4">
                          <p className="max-w-[220px] truncate text-[12px] font-medium">
                            {v.product_name}
                          </p>
                          {v.color_name && (
                            <p className="mt-0.5 text-[10px] text-black/30">
                              {v.color_name}
                            </p>
                          )}
                        </td>

                        <td className="whitespace-nowrap px-4 py-4 text-[12px] text-black/55">
                          {v.size}
                        </td>

                        <td className="whitespace-nowrap px-4 py-4">
                          <span className="font-mono text-[10px] text-black/45">
                            {v.sku}
                          </span>
                        </td>

                        <td className="px-4 py-4 text-[12px] font-medium">
                          {v.stock_on_hand}
                        </td>

                        <td className="px-4 py-4 text-[12px] text-black/45">
                          {v.reserved_quantity}
                        </td>

                        <td className={[
                          'px-4 py-4 text-[12px] font-semibold',
                          available > 0 ? 'text-emerald-700' : 'text-red-600',
                        ].join(' ')}>
                          {available}
                        </td>

                        <td className="px-4 py-4">
                          {!v.active ? (
                            <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-500">
                              Inactive
                            </span>
                          ) : isSoldOut ? (
                            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.06em] text-red-700">
                              Sold out
                            </span>
                          ) : (
                            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.06em] text-emerald-700">
                              Active
                            </span>
                          )}
                        </td>

                        <td className="whitespace-nowrap px-4 py-4 text-[10px] text-black/30">
                          {new Date(v.updated_at).toLocaleString()}
                        </td>

                        <td className="whitespace-nowrap px-4 py-4 text-right">
                          <span className="text-[10px] font-medium text-black/35">
                            Manage →
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Variant management */}
        {sel && (
          <aside className="w-full flex-shrink-0 overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.02)] 2xl:sticky 2xl:top-6 2xl:w-[410px]">
            <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
              <div className="min-w-0">
                <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                  Manage variant
                </p>
                <h2 className="mt-1.5 truncate font-mono text-[12px] font-medium">
                  {sel.sku}
                </h2>
              </div>

              <button
                onClick={() => {
                  setSelected(null)
                  setMovements([])
                  setFeedback(null)
                }}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-black/30 transition hover:bg-black/[0.04] hover:text-black"
                aria-label="Close variant"
              >
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M3 3l12 12M15 3 3 15"
                    stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            <div className="px-5 py-5">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-[#F8F8F6] p-3">
                  <p className="text-[8px] font-medium uppercase tracking-[0.12em] text-black/30">
                    On hand
                  </p>
                  <p className="mt-2 text-[20px] font-medium">{sel.stock_on_hand}</p>
                </div>

                <div className="rounded-lg bg-[#F8F8F6] p-3">
                  <p className="text-[8px] font-medium uppercase tracking-[0.12em] text-black/30">
                    Reserved
                  </p>
                  <p className="mt-2 text-[20px] font-medium">{sel.reserved_quantity}</p>
                </div>

                <div className="rounded-lg bg-[#F8F8F6] p-3">
                  <p className="text-[8px] font-medium uppercase tracking-[0.12em] text-black/30">
                    Available
                  </p>
                  <p className={[
                    'mt-2 text-[20px] font-medium',
                    Number(sel.available_quantity) > 0 ? 'text-emerald-700' : 'text-red-600',
                  ].join(' ')}>
                    {sel.available_quantity}
                  </p>
                </div>
              </div>

              <div className="mt-5">
                <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                  Adjust inventory
                </p>

                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] font-medium text-black/45">
                      Action
                    </span>
                    <select
                      value={form.type}
                      onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                      className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none focus:border-black/25"
                    >
                      <option value="ADD">Add stock</option>
                      <option value="REMOVE">Remove stock</option>
                      <option value="SET">Set absolute quantity</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[10px] font-medium text-black/45">
                      Quantity *
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={form.quantity}
                      onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                      className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none focus:border-black/25"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[10px] font-medium text-black/45">
                      Reason *
                    </span>
                    <input
                      type="text"
                      value={form.reason}
                      onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                      placeholder="e.g. Initial stock entry"
                      className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none placeholder:text-black/25 focus:border-black/25"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[10px] font-medium text-black/45">
                      Note <span className="font-normal text-black/25">(optional)</span>
                    </span>
                    <input
                      type="text"
                      value={form.note}
                      onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                      className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none focus:border-black/25"
                    />
                  </label>

                  <button
                    onClick={submit}
                    disabled={submitting || !form.reason.trim() || form.quantity === ''}
                    className="h-11 w-full rounded-lg bg-[#111111] text-[11px] font-medium tracking-[0.04em] text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {submitting ? 'Saving…' : 'Save adjustment'}
                  </button>
                </div>
              </div>

              {feedback && (
                <div className={[
                  'mt-4 rounded-lg border px-3 py-2.5 text-[11px]',
                  feedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700',
                ].join(' ')}>
                  {feedback.msg}
                </div>
              )}

              <div className="mt-5 border-t border-black/[0.06] pt-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                      Availability
                    </p>
                    <p className="mt-1 text-[11px] text-black/40">
                      {sel.active ? 'Variant is active' : 'Variant is inactive'}
                    </p>
                  </div>

                  <button
                    onClick={() => {
                      if (confirm(`${sel.active ? 'Deactivate' : 'Activate'} ${sel.sku}?`)) {
                        toggleActive(sel.id, sel.active)
                      }
                    }}
                    className={[
                      'h-9 rounded-lg border px-3 text-[10px] font-medium transition',
                      sel.active
                        ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
                    ].join(' ')}
                  >
                    {sel.active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>

              <div className="mt-5 border-t border-black/[0.06] pt-5">
                <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                  Recent movements
                </p>

                {movements.length === 0 ? (
                  <div className="rounded-lg bg-[#F8F8F6] px-3 py-5 text-center">
                    <p className="text-[10px] text-black/30">No movements recorded.</p>
                  </div>
                ) : (
                  <div className="max-h-[300px] space-y-2 overflow-y-auto">
                    {movements.map(m => (
                      <div
                        key={m.id}
                        className="rounded-lg border border-black/[0.06] bg-[#FAFAF9] p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-medium text-black/60">
                              {m.reason}
                            </p>
                            <p className="mt-1 text-[9px] text-black/30">
                              {m.movement_type} · {new Date(m.created_at).toLocaleString()}
                            </p>
                          </div>

                          <span className={[
                            'flex-shrink-0 text-[12px] font-semibold',
                            m.quantity_delta >= 0 ? 'text-emerald-700' : 'text-red-600',
                          ].join(' ')}>
                            {m.quantity_delta >= 0 ? '+' : ''}{m.quantity_delta}
                          </span>
                        </div>

                        {m.note && (
                          <p className="mt-2 text-[10px] leading-4 text-black/40">
                            {m.note}
                          </p>
                        )}

                        <p className="mt-2 truncate text-[9px] text-black/25">
                          {m.actor_email}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
