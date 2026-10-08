'use client'
// app/admin/financials/costs/CostsClient.tsx
// Product COGS management.
//
// Adding a batch changes what FUTURE orders cost. It never alters an order that has
// already been paid, because the cost is snapshotted onto order_items at sale time.

import { useEffect, useState, useCallback } from 'react'
import { money, moneyOrUnknown } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

type Batch = {
  id: string; productName: string | null; variantSku: string | null
  colorName: string | null; batchLabel: string | null
  manufacturingCents: number; freightCents: number; dutiesCents: number
  tariffsCents: number; importTaxCents: number
  packagingCents: number; otherLandedCents: number
  unitCogsCents: number; effectiveFrom: string; note: string | null
}
type Coverage = {
  variantId: string; sku: string; productName: string; colorName: string; size: string
  unitCogsCents: number | null; batchLabel: string | null
  source: 'variant' | 'color' | 'product' | null
}
type Product = { id: string; name: string; slug: string }

const BLANK = {
  productId: '', colorName: '', batchLabel: '',
  manufacturingCents: '', freightCents: '', dutiesCents: '',
  tariffsCents: '', importTaxCents: '', packagingCents: '', otherLandedCents: '',
  effectiveFrom: new Date().toISOString().slice(0, 10), note: '',
}

export function CostsClient() {
  const [batches, setBatches]   = useState<Batch[]>([])
  const [coverage, setCoverage] = useState<Coverage[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [form, setForm]         = useState({ ...BLANK })
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/product-costs')
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load costs.'); return }
      setBatches(json.batches); setCoverage(json.coverage); setProducts(json.products)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toCents = (v: string) => {
    if (!v.trim()) return 0
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : 0
  }

  const preview =
    toCents(form.manufacturingCents) + toCents(form.freightCents) + toCents(form.dutiesCents) +
    toCents(form.tariffsCents) + toCents(form.importTaxCents) +
    toCents(form.packagingCents) + toCents(form.otherLandedCents)

  async function submit() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/product-costs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId:          form.productId,
          colorName:          form.colorName || null,
          batchLabel:         form.batchLabel || null,
          manufacturingCents: toCents(form.manufacturingCents),
          freightCents:       toCents(form.freightCents),
          dutiesCents:        toCents(form.dutiesCents),
          tariffsCents:       toCents(form.tariffsCents),
          importTaxCents:     toCents(form.importTaxCents),
          packagingCents:     toCents(form.packagingCents),
          otherLandedCents:   toCents(form.otherLandedCents),
          effectiveFrom:      form.effectiveFrom,
          note:               form.note || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save.'); return }
      setForm({ ...BLANK }); setShowForm(false); await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  const missing = coverage.filter(c => c.unitCogsCents === null)

  return (
    <AdminPage>
      <AdminPageHeader
        title="Product costs"
        description="Landed cost per production batch."
        info="Landed cost per batch: manufacturing + freight + duties + tariffs + import tax + packaging + other landed costs. Cost batches are append-only: a new batch affects future applicable orders only, and historical paid-order COGS snapshots never change."
        actions={
          <AdminButton variant={showForm ? 'secondary' : 'primary'} onClick={() => setShowForm(v => !v)}>
            {showForm ? 'Cancel' : 'Add cost batch'}
          </AdminButton>
        }
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}

      {missing.length > 0 && (
        <AdminNotice tone="warning" className="mb-4" title={`${missing.length} active SKU${missing.length === 1 ? '' : 's'} have no cost defined.`}>
          Orders containing them show profit as “Pending”, not $0.
        </AdminNotice>
      )}

      {showForm && (
        <AdminCard className="mb-7">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AdminField label="Product *" htmlFor="pc-product">
              <select id="pc-product" value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value })}
                      className={adminSelectClass}>
                <option value="">Select…</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </AdminField>
            <AdminField label="Colour (optional — blank = all colours)" htmlFor="pc-colour">
              <input id="pc-colour" value={form.colorName} onChange={e => setForm({ ...form, colorName: e.target.value })}
                     placeholder="Black" className={adminInputClass} />
            </AdminField>
            <AdminField label="Batch label" htmlFor="pc-batch">
              <input id="pc-batch" value={form.batchLabel} onChange={e => setForm({ ...form, batchLabel: e.target.value })}
                     placeholder="Run-2025-Q1" className={adminInputClass} />
            </AdminField>
            <AdminField label="Effective from *" htmlFor="pc-eff">
              <input id="pc-eff" type="date" value={form.effectiveFrom}
                     onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                     className={adminInputClass} />
            </AdminField>
            {([
              ['manufacturingCents', 'Manufacturing $'],
              ['freightCents',       'Inbound freight $'],
              ['dutiesCents',        'Duties $'],
              ['tariffsCents',       'Tariffs $'],
              ['importTaxCents',     'Import tax $'],
              ['packagingCents',     'Packaging $'],
              ['otherLandedCents',   'Other landed $'],
            ] as const).map(([key, label]) => (
              <AdminField key={key} label={label} htmlFor={`pc-${key}`}>
                <input id={`pc-${key}`} type="number" step="0.01" min="0"
                       value={(form as any)[key]}
                       onChange={e => setForm({ ...form, [key]: e.target.value })}
                       placeholder="0.00" className={adminInputClass} />
              </AdminField>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <span className="text-[12px]">
              Landed unit cost: <strong className="font-medium">{money(preview)}</strong>
            </span>
            <AdminButton variant="primary" onClick={submit} loading={saving} disabled={!form.productId || preview <= 0}>
              Save batch
            </AdminButton>
          </div>
        </AdminCard>
      )}

      <AdminSectionHeader title="Coverage" description="Current cost per active SKU."
        info="Resolved in order: variant, then colour, then product." />
      <div className="mb-7">
        {loading ? <AdminLoading /> : coverage.length === 0 ? <AdminEmpty title="No active SKUs." /> : (
          <AdminTable minWidth={600} caption="Cost coverage by SKU">
            <thead>
              <tr>{['SKU', 'Product', 'Colour', 'Size', 'Unit cost', 'Source'].map(h => <AdminTh key={h}>{h}</AdminTh>)}</tr>
            </thead>
            <tbody>
              {coverage.map(c => (
                <tr key={c.variantId}>
                  <AdminTd className="font-mono text-[11px]">{c.sku}</AdminTd>
                  <AdminTd>{c.productName}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{c.colorName}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">{c.size}</AdminTd>
                  <AdminTd className={c.unitCogsCents === null ? 'font-medium text-[#92400E]' : ''}>
                    {moneyOrUnknown(c.unitCogsCents, 'Not set')}
                  </AdminTd>
                  <AdminTd className="text-[#6B6B66]">{c.source ?? '—'}</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </div>

      <AdminSectionHeader title="Cost batches" description="Append-only history."
        info="A newer batch supersedes an older one from its effective date." />
      {batches.length === 0 && !loading ? <AdminEmpty title="No cost batches yet." /> : (
        <AdminTable minWidth={760} caption="Cost batches">
          <thead>
            <tr>{['Effective', 'Product', 'Scope', 'Batch', 'Mfg', 'Freight', 'Duties+Tax', 'Packaging', 'Unit cost'].map(h => <AdminTh key={h}>{h}</AdminTh>)}</tr>
          </thead>
          <tbody>
            {batches.map(b => (
              <tr key={b.id}>
                <AdminTd>{b.effectiveFrom}</AdminTd>
                <AdminTd>{b.productName ?? '—'}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{b.variantSku ?? b.colorName ?? 'All variants'}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{b.batchLabel ?? '—'}</AdminTd>
                <AdminTd>{money(b.manufacturingCents)}</AdminTd>
                <AdminTd>{money(b.freightCents)}</AdminTd>
                <AdminTd>{money(b.dutiesCents + b.tariffsCents + b.importTaxCents)}</AdminTd>
                <AdminTd>{money(b.packagingCents)}</AdminTd>
                <AdminTd className="font-medium">{money(b.unitCogsCents)}</AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  )
}
