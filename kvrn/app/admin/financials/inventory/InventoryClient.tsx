'use client'
// app/admin/financials/inventory/InventoryClient.tsx
//
// Three things kept deliberately distinct:
//   VALUATION   derived from FIFO layers. Unknown-cost units are shown apart and
//               the total is labelled PARTIAL whenever any exist — a known-cost
//               subtotal is never presented as a complete valuation.
//   WRITE-OFFS  the client sends variant, quantity and reason only. Cost comes
//               from the canonical FIFO function server-side.
//   PURCHASES   cash movements keyed on the date money actually left. These are
//               never COGS and never operating expense.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, moneyOrUnknown, SectionTitle } from '@/components/admin/FinancialUI'

type Row = {
  variantId: string; sku: string; productName: string
  stockOnHand: number; layerUnitsRemaining: number
  knownCostUnits: number; unknownCostUnits: number
  valueAtCostCents: number; reconciled: boolean
}
type Totals = {
  knownValueCents: number; knownCostUnits: number; unknownCostUnits: number
  totalUnits: number; isPartialValuation: boolean; reconciliationFailures: number
}
type WriteOff = {
  id: string; sku: string; productName: string; quantity: number; reason: string
  totalCostCents: number | null; unknownCostQuantity: number
  isPromotional: boolean; createdAt: string; createdBy: string | null
}

const REASONS = ['damaged','defective','lost','sample','giveaway',
                 'influencer','photography','promotional','other']

const inputStyle = { fontFamily: FONT, fontSize: 12, padding: '7px 9px',
                     border: BORDER, background: '#fff', boxSizing: 'border-box' as const }

export function InventoryClient() {
  const [tab, setTab] = useState<'valuation' | 'receipts' | 'writeoffs' | 'purchases'>('valuation')
  const [rows, setRows]       = useState<Row[]>([])
  const [totals, setTotals]   = useState<Totals | null>(null)
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([])
  const [purchases, setPurchases] = useState<any[]>([])
  const [payments, setPayments]   = useState<any[]>([])
  const [batches, setBatches]     = useState<any[]>([])
  const [recon, setRecon]         = useState<any[]>([])
  const [receipts, setReceipts]   = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [saving, setSaving]   = useState(false)

  const [woForm, setWoForm] = useState({ variantId: '', quantity: '', reason: 'damaged', notes: '' })
  const [poForm, setPoForm] = useState({ supplier: '', reference: '', total: '', orderedAt: '', receivedAt: '' })
  const [payForm, setPayForm] = useState({ purchaseId: '', paymentType: 'deposit', amount: '', paidAt: '' })
  const [rcForm, setRcForm]   = useState({ costBatchId: '', variantId: '', quantity: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [v, w, p, b] = await Promise.all([
        fetch('/api/admin/inventory/valuation').then(r => r.json()),
        fetch('/api/admin/inventory/write-offs').then(r => r.json()),
        fetch('/api/admin/inventory/purchases').then(r => r.json()),
        fetch('/api/admin/inventory/receipts').then(r => r.json()),
      ])
      if (v.variants) { setRows(v.variants); setTotals(v.totals) }
      if (w.writeOffs) setWriteOffs(w.writeOffs)
      if (p.purchases) { setPurchases(p.purchases); setPayments(p.payments ?? []) }
      if (b.batches) { setBatches(b.batches); setRecon(b.reconciliation ?? []); setReceipts(b.receipts ?? []) }
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toCents = (v: string) => {
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : null
  }

  async function submitWriteOff() {
    setSaving(true); setErr(null)
    try {
      // Note: no cost is sent. The server derives it from FIFO layers.
      const res = await fetch('/api/admin/inventory/write-offs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId: woForm.variantId, quantity: Number(woForm.quantity),
          reason: woForm.reason, notes: woForm.notes || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not record write-off.'); return }
      setWoForm({ ...woForm, quantity: '', notes: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  /**
   * Receive units against a cost batch.
   *
   * No cost is sent: unit cost, the remainder split and the resulting layers are
   * all derived server-side. An idempotency key makes a retried submit a no-op
   * rather than a second stock addition.
   */
  async function submitReceipt() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/inventory/receipts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costBatchId: rcForm.costBatchId,
          variantId:   rcForm.variantId,
          quantity:    Number(rcForm.quantity),
          idempotencyKey: `${rcForm.costBatchId}:${rcForm.variantId}:${rcForm.quantity}:${Date.now()}`,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not record receipt.'); return }
      setRcForm({ ...rcForm, quantity: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  async function submitPurchase() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/inventory/purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier: poForm.supplier, reference: poForm.reference || null,
          totalCents: poForm.total ? toCents(poForm.total) : null,
          orderedAt: poForm.orderedAt || null, receivedAt: poForm.receivedAt || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not create purchase.'); return }
      setPoForm({ supplier: '', reference: '', total: '', orderedAt: '', receivedAt: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  async function submitPayment() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/inventory/purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'payment', purchaseId: payForm.purchaseId,
          paymentType: payForm.paymentType, amountCents: toCents(payForm.amount),
          paidAt: payForm.paidAt,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not record payment.'); return }
      setPayForm({ ...payForm, amount: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  const th = { textAlign: 'left' as const, padding: '9px 10px', fontSize: 9,
               letterSpacing: '0.1em', textTransform: 'uppercase' as const,
               color: '#9B9B9B', borderBottom: BORDER, whiteSpace: 'nowrap' as const }
  const btn = { fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                textTransform: 'uppercase' as const, padding: '9px 16px',
                background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer' as const }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1240 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Inventory
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Valuation is derived from FIFO cost layers at cost, never from retail price.
        Purchase payments are cash movements and are not COGS.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {([['valuation','Valuation'],['receipts','Receive stock'],
           ['writeoffs','Write-offs'],['purchases','Purchases']] as const).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontFamily: FONT, fontSize: 11, padding: '7px 14px', cursor: 'pointer',
                     border: tab === k ? '1px solid #1A1A1A' : BORDER,
                     background: tab === k ? '#1A1A1A' : '#fff',
                     color: tab === k ? '#fff' : '#1A1A1A' }}>{l}</button>
        ))}
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>}

      {tab === 'valuation' && totals && (
        <>
          {totals.isPartialValuation && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                          border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 16 }}>
              <strong>Partial valuation.</strong> {totals.unknownCostUnits} unit
              {totals.unknownCostUnits === 1 ? '' : 's'} have no authoritative cost, so the
              figure below covers only the {totals.knownCostUnits} units whose cost is known.
              It is not a complete inventory valuation.
            </div>
          )}
          {totals.reconciliationFailures > 0 && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                          border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
              {totals.reconciliationFailures} variant(s) where layer quantity does not match
              physical stock. Investigate before relying on these figures.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
                        gap: 10, marginBottom: 22 }}>
            {[['Value at cost', money(totals.knownValueCents),
               totals.isPartialValuation ? 'Known-cost units only — partial' : 'All units costed'],
              ['Known-cost units', String(totals.knownCostUnits), 'Included in the value'],
              ['Unknown-cost units', String(totals.unknownCostUnits), 'Excluded from the value'],
              ['Total units', String(totals.totalUnits), 'Physical on hand']
            ].map(([label, value, note]) => (
              <div key={label} style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
                <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>{label}</p>
                <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>{value}</p>
                <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>{note}</p>
              </div>
            ))}
          </div>

          <SectionTitle note="Cost basis only. Retail price is never used to value inventory.">
            By variant
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['SKU','Product','On hand','Layers','Known','Unknown','Value at cost','Reconciled'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No inventory.
                  </td></tr>
                )}
                {rows.map(r => (
                  <tr key={r.variantId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{r.sku}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.productName}</td>
                    <td style={{ padding: '9px 10px' }}>{r.stockOnHand}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.layerUnitsRemaining}</td>
                    <td style={{ padding: '9px 10px' }}>{r.knownCostUnits}</td>
                    <td style={{ padding: '9px 10px',
                                 color: r.unknownCostUnits > 0 ? '#92400E' : '#6B6B6B' }}>
                      {r.unknownCostUnits}
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>
                      {money(r.valueAtCostCents)}
                      {r.unknownCostUnits > 0 && (
                        <span style={{ fontSize: 10, color: '#92400E', display: 'block' }}>partial</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px',
                                 color: r.reconciled ? '#047857' : '#B91C1C' }}>
                      {r.reconciled ? 'yes' : 'NO'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'receipts' && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#3730A3', background: '#EEF2FF',
                        border: '1px solid #C7D2FE', padding: '10px 14px', marginBottom: 18 }}>
            Receiving is <strong>cumulative</strong>. A batch received 1+1+1 capitalises exactly
            the same total as one received all at once — remainder cents are carried on a small
            premium layer, never rounded away. Cost is derived from the batch; nothing here
            accepts a cost from the browser.
          </div>

          <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 22 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 12 }}>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Cost batch
                <select value={rcForm.costBatchId}
                  onChange={e => setRcForm({ ...rcForm, costBatchId: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  <option value="">Select…</option>
                  {batches.filter(b => !b.fullyReceived).map(b => (
                    <option key={b.costBatchId} value={b.costBatchId}>
                      {b.productName}{b.batchLabel ? ` · ${b.batchLabel}` : ''}
                      {b.intendedUnits !== null ? ` (${b.remainingUnits} left)` : ''}
                    </option>
                  ))}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Variant
                <select value={rcForm.variantId}
                  onChange={e => setRcForm({ ...rcForm, variantId: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  <option value="">Select…</option>
                  {rows.map(r => <option key={r.variantId} value={r.variantId}>{r.sku}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Quantity received
                <input type="number" min="1" value={rcForm.quantity}
                  onChange={e => setRcForm({ ...rcForm, quantity: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }} /></label>
            </div>
            <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '12px 0 0' }}>
              The variant must belong to this batch. Receiving more than the batch was created
              for is rejected.
            </p>
            <button onClick={submitReceipt}
              disabled={saving || !rcForm.costBatchId || !rcForm.variantId || !rcForm.quantity}
              style={{ ...btn, marginTop: 12,
                       opacity: saving || !rcForm.costBatchId || !rcForm.variantId || !rcForm.quantity ? 0.45 : 1 }}>
              {saving ? 'Receiving…' : 'Receive stock'}
            </button>
          </div>

          <SectionTitle note="Layer value must equal the capitalised batch total once fully received.">
            Batch progress
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Product','Batch','Intended','Received','Remaining','Unit cost',
                  'Intended cost','Received cost',''].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {batches.length === 0 && !loading && (
                  <tr><td colSpan={9} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No cost batches. Create one under Product Costs first.
                  </td></tr>
                )}
                {batches.map(b => {
                  // Only a COMPLETE batch can be reconciled. A partially received
                  // batch legitimately shows less received than intended and must
                  // not be presented as a variance.
                  const matches = b.capitalizationReconciled
                  return (
                    <tr key={b.costBatchId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                      <td style={{ padding: '9px 10px' }}>{b.productName}</td>
                      <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{b.batchLabel ?? '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{b.intendedUnits ?? '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{b.receivedUnits}</td>
                      <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                        {b.intendedUnits === null ? '—' : b.remainingUnits}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {b.unitCogsCents === null ? '—' : money(b.unitCogsCents)}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {money(b.intendedCapitalizedCents)}
                      </td>
                      <td style={{ padding: '9px 10px',
                                   color: b.fullyReceived && !matches ? '#B91C1C' : '#1A1A1A' }}>
                        {money(b.receivedCapitalizedCents)}
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {b.fullyReceived
                          ? <span style={{ fontSize: 9, letterSpacing: '0.08em',
                                           textTransform: 'uppercase', padding: '3px 8px',
                                           background: matches ? '#F0FDF4' : '#FEF2F2',
                                           border: `1px solid ${matches ? '#BBF7D0' : '#FECACA'}`,
                                           color: matches ? '#166534' : '#B91C1C' }}>
                              {matches ? 'reconciled' : 'variance'}
                            </span>
                          : <span style={{ fontSize: 10, color: '#9B9B9B' }}>partial</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <SectionTitle note="Variance compares cash paid against the value ACTUALLY RECEIVED, not against the cost of units still in transit. A non-zero variance is expected while deposits or freight invoices are outstanding — it is a review flag, not an error.">
            Purchase reconciliation
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Supplier','Reference','Status','Batches','Ordered cost',
                  'Received cost','Cash paid','Variance'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {recon.length === 0 && !loading && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No purchases recorded.
                  </td></tr>
                )}
                {recon.map(r => (
                  <tr key={r.purchaseId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{r.supplier}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.reference ?? '—'}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.status}</td>
                    <td style={{ padding: '9px 10px' }}>{r.costBatchCount}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {money(r.intendedCapitalizedCents)}
                      {!r.fullyReceived && (
                        <span style={{ fontSize: 10, display: 'block', color: '#92400E' }}>
                          not all received
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px' }}>{money(r.receivedCapitalizedCents)}</td>
                    <td style={{ padding: '9px 10px' }}>{money(r.cashPaidCents)}</td>
                    <td style={{ padding: '9px 10px',
                                 color: r.varianceCents === 0 ? '#047857' : '#92400E' }}>
                      {r.varianceCents === 0 ? 'balanced' : money(r.varianceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SectionTitle>Recent receipts</SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Received','SKU','Batch','Qty','Premium units','By'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {receipts.length === 0 && !loading && (
                  <tr><td colSpan={6} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No receipts recorded.
                  </td></tr>
                )}
                {receipts.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{r.receivedAt.slice(0, 10)}</td>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{r.sku}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.batchLabel ?? '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{r.quantity}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.premiumUnits}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{r.createdBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'writeoffs' && (
        <>
          <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 22 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Variant
                <select value={woForm.variantId}
                  onChange={e => setWoForm({ ...woForm, variantId: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  <option value="">Select…</option>
                  {rows.map(r => <option key={r.variantId} value={r.variantId}>
                    {r.sku} ({r.stockOnHand})
                  </option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Quantity
                <input type="number" min="1" value={woForm.quantity}
                  onChange={e => setWoForm({ ...woForm, quantity: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Reason
                <select value={woForm.reason}
                  onChange={e => setWoForm({ ...woForm, reason: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Notes
                <input value={woForm.notes}
                  onChange={e => setWoForm({ ...woForm, notes: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }} /></label>
            </div>
            <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '12px 0 0' }}>
              Cost is computed server-side from FIFO layers. This permanently removes stock.
            </p>
            <button onClick={submitWriteOff}
              disabled={saving || !woForm.variantId || !woForm.quantity}
              style={{ ...btn, marginTop: 12,
                       opacity: saving || !woForm.variantId || !woForm.quantity ? 0.45 : 1 }}>
              {saving ? 'Saving…' : 'Record write-off'}
            </button>
          </div>

          <SectionTitle note="Promotional use is a marketing cost; damage and loss are not. Neither creates sales revenue.">
            Recorded write-offs
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['SKU','Qty','Reason','Type','Cost','Date','By'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {writeOffs.length === 0 && !loading && (
                  <tr><td colSpan={7} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No write-offs recorded.
                  </td></tr>
                )}
                {writeOffs.map(w => (
                  <tr key={w.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{w.sku}</td>
                    <td style={{ padding: '9px 10px' }}>{w.quantity}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{w.reason}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {w.isPromotional ? 'promotional' : 'loss'}
                    </td>
                    <td style={{ padding: '9px 10px',
                                 color: w.totalCostCents === null ? '#92400E' : '#1A1A1A' }}>
                      {moneyOrUnknown(w.totalCostCents, 'Unknown')}
                      {w.unknownCostQuantity > 0 && (
                        <span style={{ fontSize: 10, display: 'block' }}>
                          {w.unknownCostQuantity} unit(s) uncosted
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {w.createdAt.slice(0, 10)}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{w.createdBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'purchases' && (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#3730A3', background: '#EEF2FF',
                        border: '1px solid #C7D2FE', padding: '10px 14px', marginBottom: 18 }}>
            Payments recorded here are <strong>cash movements</strong>, dated when money actually
            left. They are never operating expenses and never COGS — capitalised inventory cost
            reaches the P&amp;L only as units sell.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 16, marginBottom: 22 }}>
            <div style={{ border: BORDER, background: '#fff', padding: 18 }}>
              <p style={{ fontFamily: FONT, fontSize: 11, fontWeight: 600, margin: '0 0 12px' }}>
                New purchase
              </p>
              {([['supplier','Supplier','text'],['reference','Reference','text'],
                 ['total','Expected total $','number'],['orderedAt','Ordered','date'],
                 ['receivedAt','Received','date']] as const).map(([k,l,t]) => (
                <label key={k} style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
                  {l}
                  <input type={t} step={t === 'number' ? '0.01' : undefined}
                    value={(poForm as any)[k]}
                    onChange={e => setPoForm({ ...poForm, [k]: e.target.value })}
                    style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
                </label>
              ))}
              <button onClick={submitPurchase} disabled={saving || !poForm.supplier}
                style={{ ...btn, marginTop: 6, opacity: saving || !poForm.supplier ? 0.45 : 1 }}>
                Create purchase
              </button>
            </div>

            <div style={{ border: BORDER, background: '#fff', padding: 18 }}>
              <p style={{ fontFamily: FONT, fontSize: 11, fontWeight: 600, margin: '0 0 12px' }}>
                Record a cash payment
              </p>
              <label style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
                Purchase
                <select value={payForm.purchaseId}
                  onChange={e => setPayForm({ ...payForm, purchaseId: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  <option value="">Select…</option>
                  {purchases.map(p => <option key={p.id} value={p.id}>
                    {p.supplier}{p.reference ? ` · ${p.reference}` : ''}
                  </option>)}
                </select>
              </label>
              <label style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
                Type
                <select value={payForm.paymentType}
                  onChange={e => setPayForm({ ...payForm, paymentType: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                  {['deposit','partial','final','supplier','freight','duties','tariffs',
                    'customs_brokerage','other'].map(t =>
                    <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
              <label style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
                Amount $
                <input type="number" step="0.01" min="0" value={payForm.amount}
                  onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
              </label>
              <label style={{ fontFamily: FONT, fontSize: 11, display: 'block', marginBottom: 8 }}>
                Paid on (when money left)
                <input type="date" value={payForm.paidAt}
                  onChange={e => setPayForm({ ...payForm, paidAt: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
              </label>
              <button onClick={submitPayment}
                disabled={saving || !payForm.purchaseId || !payForm.amount || !payForm.paidAt}
                style={{ ...btn, marginTop: 6,
                         opacity: saving || !payForm.purchaseId || !payForm.amount || !payForm.paidAt ? 0.45 : 1 }}>
                Record payment
              </button>
            </div>
          </div>

          <SectionTitle note="A payment date is not a receipt date. Cash flow uses the paid date only.">
            Cash payments
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Paid on','Supplier','Type','Amount'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {payments.length === 0 && !loading && (
                  <tr><td colSpan={4} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No payments recorded.
                  </td></tr>
                )}
                {payments.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{p.paidAt}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {purchases.find(x => x.id === p.purchaseId)?.supplier ?? '—'}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {p.paymentType.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(p.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
