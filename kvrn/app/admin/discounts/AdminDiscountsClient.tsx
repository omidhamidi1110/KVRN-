'use client'
import { useEffect, useState } from 'react'
import {
  AdminPage, AdminPageHeader, AdminCard, AdminSectionHeader, AdminButton, AdminNotice, AdminField, AdminFieldGrid,
  AdminTable, AdminTh, AdminTd, AdminEmpty, AdminLoading, AdminError, StatusBadge,
  adminInputClass, adminSelectClass, adminCheckboxClass,
} from '@/components/admin/ui/AdminUI'

type Discount = {
  id: string; code: string; name: string; description: string | null
  type: 'fixed_amount' | 'percentage' | 'shipping'
  amountCents: number | null; percentageBps: number | null
  active: boolean; singleUse: boolean
  maxRedemptions: number | null; redemptionCount: number
  minimumSubtotalCents: number | null
  startsAt: string | null; expiresAt: string | null
  createdAt: string
}

function fmtVal(d: Discount): string {
  if (d.type === 'fixed_amount' && d.amountCents !== null) return `$${(d.amountCents/100).toFixed(2)}`
  if (d.type === 'percentage'   && d.percentageBps !== null) return `${d.percentageBps/100}%`
  if (d.type === 'shipping') return 'Shipping'
  return '—'
}

function fmt(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' })
}

const emptyForm = {
  code:'', name:'', description:'', type:'fixed_amount' as Discount['type'],
  amountCents: 1000, percentageBps: null as number | null,
  active: true, singleUse: false, maxRedemptions: null as number | null,
  minimumSubtotalCents: null as number | null,
  startsAt: '', expiresAt: '',
}

export function AdminDiscountsClient() {
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [form,      setForm]      = useState(emptyForm)
  const [creating,  setCreating]  = useState(false)
  const [showForm,  setShowForm]  = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [notice,    setNotice]    = useState('')

  const load = () => {
    setLoading(true)
    setError('')
    fetch('/api/admin/discounts')
      .then(r => r.json())
      .then(j => { if (j.success) setDiscounts(j.data); else setError(j.error ?? 'Failed.') })
      .catch(() => setError('Network error.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this discount? The code stops working at checkout.')) return
    const r = await fetch(`/api/admin/discounts/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    })
    if (r.ok) load()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this discount? This cannot be undone.')) return
    const r = await fetch(`/api/admin/discounts/${id}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok) { setNotice(j.error ?? 'Couldn’t delete this discount.'); return }
    setNotice('')
    load()
  }

  const handleCreate = async () => {
    setSaving(true)
    const r = await fetch('/api/admin/discounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amountCents:         form.type === 'fixed_amount' ? form.amountCents : null,
        percentageBps:       form.type === 'percentage'   ? form.percentageBps : null,
        startsAt:            form.startsAt  || null,
        expiresAt:           form.expiresAt || null,
        description:         form.description || null,
        maxRedemptions:      form.maxRedemptions,
        minimumSubtotalCents:form.minimumSubtotalCents,
      })
    })
    const j = await r.json()
    setSaving(false)
    if (!r.ok) { setNotice(j.error ?? 'Couldn’t create this discount.'); return }
    setNotice('')
    setShowForm(false)
    setForm(emptyForm)
    load()
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Discounts"
        description="Codes and checkout offers."
        actions={
          <AdminButton variant={showForm ? 'secondary' : 'primary'} onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : 'New discount'}
          </AdminButton>
        }
      />

      {notice && <AdminNotice tone="danger" className="mb-4">{notice}</AdminNotice>}

      {showForm && (
        <AdminCard className="mb-5">
          <AdminSectionHeader title="Create discount" />
          <AdminFieldGrid cols={3}>
            <AdminField label="Code *" htmlFor="dc-code">
              <input id="dc-code" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} className={adminInputClass} placeholder="KVRN10" />
            </AdminField>
            <AdminField label="Name *" htmlFor="dc-name">
              <input id="dc-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={adminInputClass} placeholder="Internal name" />
            </AdminField>
            <AdminField label="Type *" htmlFor="dc-type">
              <select id="dc-type" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as Discount['type'] }))} className={adminSelectClass}>
                <option value="fixed_amount">Fixed amount</option>
                <option value="percentage">Percentage</option>
                <option value="shipping">Shipping</option>
              </select>
            </AdminField>
          </AdminFieldGrid>
          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {form.type === 'fixed_amount' && (
              <AdminField label="Amount (cents)" htmlFor="dc-amount"
                info="Whole cents. 1000 = $10.00.">
                <input id="dc-amount" type="number" value={form.amountCents ?? ''} onChange={e => setForm(f => ({ ...f, amountCents: Number(e.target.value) }))} className={adminInputClass} placeholder="1000" />
              </AdminField>
            )}
            {form.type === 'percentage' && (
              <AdminField label="Percent (BPS)" htmlFor="dc-bps"
                info="Basis points: 100 BPS = 1%. 1000 = 10%.">
                <input id="dc-bps" type="number" value={form.percentageBps ?? ''} onChange={e => setForm(f => ({ ...f, percentageBps: Number(e.target.value) }))} className={adminInputClass} placeholder="1000" />
              </AdminField>
            )}
            <AdminField label="Max uses" htmlFor="dc-max">
              <input id="dc-max" type="number" value={form.maxRedemptions ?? ''} onChange={e => setForm(f => ({ ...f, maxRedemptions: e.target.value ? Number(e.target.value) : null }))} className={adminInputClass} placeholder="Unlimited" />
            </AdminField>
            <AdminField label="Min subtotal (cents)" htmlFor="dc-min"
              info="Whole cents. 5000 = $50.00. Leave empty for no minimum.">
              <input id="dc-min" type="number" value={form.minimumSubtotalCents ?? ''} onChange={e => setForm(f => ({ ...f, minimumSubtotalCents: e.target.value ? Number(e.target.value) : null }))} className={adminInputClass} placeholder="None" />
            </AdminField>
            <AdminField label="Expires at" htmlFor="dc-exp">
              <input id="dc-exp" type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} className={adminInputClass} />
            </AdminField>
          </div>
          <div className="mb-4 flex flex-wrap gap-5">
            <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-[12px]">
              <input type="checkbox" className={adminCheckboxClass} checked={form.singleUse} onChange={e => setForm(f => ({ ...f, singleUse: e.target.checked }))} />
              Single use
            </label>
            <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-[12px]">
              <input type="checkbox" className={adminCheckboxClass} checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
              Active
            </label>
          </div>
          <AdminButton variant="primary" onClick={handleCreate} loading={saving}>Create discount</AdminButton>
        </AdminCard>
      )}

      {loading && <AdminLoading />}
      {error   && <AdminError message={error} onRetry={load} />}

      {!loading && (
        discounts.length === 0 && !error ? (
          <AdminEmpty title="No discounts yet." />
        ) : discounts.length > 0 && (
          <AdminTable minWidth={900} caption="Discounts" stack>
            <thead>
              <tr>
                {['Code','Name','Type','Value','Status','Single use','Uses','Max','Min subtotal','Expires','Created'].map(h => (
                  <AdminTh key={h}>{h}</AdminTh>
                ))}
                <AdminTh><span className="sr-only">Actions</span></AdminTh>
              </tr>
            </thead>
            <tbody>
              {discounts.map(d => (
                <tr key={d.id}>
                  <AdminTd className="font-mono font-medium">{d.code}</AdminTd>
                  <AdminTd className="text-[#4A4A46]">{d.name}</AdminTd>
                  <AdminTd className="capitalize text-[#6B6B66]">{d.type.replace('_',' ')}</AdminTd>
                  <AdminTd>{fmtVal(d)}</AdminTd>
                  <AdminTd><StatusBadge status={d.active ? 'Active' : 'Inactive'} /></AdminTd>
                  <AdminTd className="text-[#6B6B66]">{d.singleUse ? 'Yes' : 'No'}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{d.redemptionCount}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{d.maxRedemptions ?? '∞'}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{d.minimumSubtotalCents ? `$${(d.minimumSubtotalCents/100).toFixed(2)}` : '—'}</AdminTd>
                  <AdminTd className="whitespace-nowrap text-[#6B6B66]">{fmt(d.expiresAt)}</AdminTd>
                  <AdminTd className="whitespace-nowrap text-[#8A8A85]">{fmt(d.createdAt)}</AdminTd>
                  <AdminTd className="whitespace-nowrap">
                    <span className="flex gap-1.5">
                      {d.active && (
                        <AdminButton size="sm" onClick={() => handleDeactivate(d.id)}>Deactivate</AdminButton>
                      )}
                      {d.redemptionCount === 0 && (
                        <AdminButton size="sm" variant="danger" onClick={() => handleDelete(d.id)}>Delete</AdminButton>
                      )}
                    </span>
                  </AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )
      )}
    </AdminPage>
  )
}
