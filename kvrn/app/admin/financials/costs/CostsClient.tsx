'use client'
// app/admin/financials/costs/CostsClient.tsx
// Product COGS management.
//
// Adding a batch changes what FUTURE orders cost. It never alters an order that has
// already been paid, because the cost is snapshotted onto order_items at sale time.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, moneyOrUnknown, SectionTitle } from '@/components/admin/FinancialUI'

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
  const inputStyle = { fontFamily: FONT, fontSize: 12, padding: '8px 10px',
                       border: BORDER, background: '#fff', width: '100%',
                       boxSizing: 'border-box' as const }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Product costs
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Landed unit cost per production batch: manufacturing + freight + duties + tariffs
        + import tax + packaging + other landed costs. Cost batches are append-only —
        adding a new batch affects future applicable orders only, and historical paid-order
        COGS snapshots never change.
      </p>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}

      {missing.length > 0 && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                      border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 18 }}>
          {missing.length} active SKU{missing.length === 1 ? '' : 's'} have no cost defined.
          Orders containing them will show profit as “Pending” rather than assuming zero cost.
        </div>
      )}

      <button onClick={() => setShowForm(v => !v)}
        style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                 padding: '9px 16px', background: '#1A1A1A', color: '#fff',
                 border: 'none', cursor: 'pointer', marginBottom: 18 }}>
        {showForm ? 'Cancel' : 'Add cost batch'}
      </button>

      {showForm && (
        <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 26 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 12 }}>
            <label style={{ fontFamily: FONT, fontSize: 11 }}>
              Product *
              <select value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value })}
                      style={{ ...inputStyle, marginTop: 4 }}>
                <option value="">Select…</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label style={{ fontFamily: FONT, fontSize: 11 }}>
              Colour (optional — blank = all colours)
              <input value={form.colorName} onChange={e => setForm({ ...form, colorName: e.target.value })}
                     placeholder="Black" style={{ ...inputStyle, marginTop: 4 }} />
            </label>
            <label style={{ fontFamily: FONT, fontSize: 11 }}>
              Batch label
              <input value={form.batchLabel} onChange={e => setForm({ ...form, batchLabel: e.target.value })}
                     placeholder="Run-2025-Q1" style={{ ...inputStyle, marginTop: 4 }} />
            </label>
            <label style={{ fontFamily: FONT, fontSize: 11 }}>
              Effective from *
              <input type="date" value={form.effectiveFrom}
                     onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                     style={{ ...inputStyle, marginTop: 4 }} />
            </label>
            {([
              ['manufacturingCents', 'Manufacturing $'],
              ['freightCents',       'Inbound freight $'],
              ['dutiesCents',        'Duties $'],
              ['tariffsCents',       'Tariffs $'],
              ['importTaxCents',     'Import tax $'],
              ['packagingCents',     'Packaging $'],
              ['otherLandedCents',   'Other landed $'],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ fontFamily: FONT, fontSize: 11 }}>
                {label}
                <input type="number" step="0.01" min="0"
                       value={(form as any)[key]}
                       onChange={e => setForm({ ...form, [key]: e.target.value })}
                       placeholder="0.00" style={{ ...inputStyle, marginTop: 4 }} />
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16 }}>
            <span style={{ fontFamily: FONT, fontSize: 12, color: '#1A1A1A' }}>
              Landed unit cost: <strong>{money(preview)}</strong>
            </span>
            <button onClick={submit} disabled={saving || !form.productId || preview <= 0}
              style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                       textTransform: 'uppercase', padding: '9px 16px',
                       background: '#1A1A1A', color: '#fff', border: 'none',
                       cursor: saving ? 'default' : 'pointer',
                       opacity: saving || !form.productId || preview <= 0 ? 0.45 : 1 }}>
              {saving ? 'Saving…' : 'Save batch'}
            </button>
          </div>
        </div>
      )}

      <SectionTitle note="Current effective cost for each active SKU, resolved variant → colour → product.">
        Coverage
      </SectionTitle>
      <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#FAF9F7' }}>
              {['SKU', 'Product', 'Colour', 'Size', 'Unit cost', 'Source'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                     letterSpacing: '0.1em', textTransform: 'uppercase',
                                     color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ padding: '18px 12px', color: '#6B6B6B' }}>Loading…</td></tr>}
            {coverage.map(c => (
              <tr key={c.variantId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                <td style={{ padding: '9px 12px', fontFamily: 'monospace' }}>{c.sku}</td>
                <td style={{ padding: '9px 12px' }}>{c.productName}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{c.colorName}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{c.size}</td>
                <td style={{ padding: '9px 12px',
                             color: c.unitCogsCents === null ? '#92400E' : '#1A1A1A' }}>
                  {moneyOrUnknown(c.unitCogsCents, 'Not set')}
                </td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{c.source ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle note="Append-only history. A newer batch supersedes an older one from its effective date.">
        Cost batches
      </SectionTitle>
      <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#FAF9F7' }}>
              {['Effective', 'Product', 'Scope', 'Batch', 'Mfg', 'Freight', 'Duties+Tax', 'Packaging', 'Unit cost'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                     letterSpacing: '0.1em', textTransform: 'uppercase',
                                     color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                No cost batches yet.
              </td></tr>
            )}
            {batches.map(b => (
              <tr key={b.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                <td style={{ padding: '9px 12px' }}>{b.effectiveFrom}</td>
                <td style={{ padding: '9px 12px' }}>{b.productName ?? '—'}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                  {b.variantSku ?? b.colorName ?? 'All variants'}
                </td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{b.batchLabel ?? '—'}</td>
                <td style={{ padding: '9px 12px' }}>{money(b.manufacturingCents)}</td>
                <td style={{ padding: '9px 12px' }}>{money(b.freightCents)}</td>
                <td style={{ padding: '9px 12px' }}>
                  {money(b.dutiesCents + b.tariffsCents + b.importTaxCents)}
                </td>
                <td style={{ padding: '9px 12px' }}>{money(b.packagingCents)}</td>
                <td style={{ padding: '9px 12px', fontWeight: 500 }}>{money(b.unitCogsCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
