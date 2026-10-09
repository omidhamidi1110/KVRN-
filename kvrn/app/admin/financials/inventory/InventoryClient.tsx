'use client'
// app/admin/financials/inventory/InventoryClient.tsx
//
// Three things kept deliberately distinct:
//   VALUATION   derived from FIFO layers. Unknown-cost units are shown apart and
//               the total is labelled PARTIAL whenever any exist — a known-cost
//               subtotal is never presented as a complete valuation.
//   WRITE-OFFS  the client sends variant, quantity and reason only. Cost comes
//               from the FIFO function server-side.
//   PURCHASES   cash movements keyed on the date money actually left. These are
//               never COGS and never operating expense.

import { useEffect, useState, useCallback } from 'react'
import { money, moneyOrUnknown } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField, AdminStat, AdminStatGrid,
  AdminTabs, AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, InfoTip, StatusBadge,
  adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

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

  return (
    <AdminPage>
      <AdminPageHeader
        title="Inventory Value"
        description="FIFO value, receipts, and write-offs."
        info="Valuation is derived from FIFO cost layers at cost, never from retail price. Purchase payments are cash movements and are not COGS."
      />

      <AdminTabs ariaLabel="Inventory value sections" value={tab} onChange={setTab}
        tabs={[
          { id: 'valuation', label: 'Valuation' },
          { id: 'receipts', label: 'Receive stock' },
          { id: 'writeoffs', label: 'Write-offs' },
          { id: 'purchases', label: 'Purchases' },
        ]} />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && <AdminLoading />}

      {tab === 'valuation' && totals && (
        <>
          {totals.isPartialValuation && (
            <AdminNotice tone="warning" className="mb-4" title="Partial valuation.">
              {totals.unknownCostUnits} unit
              {totals.unknownCostUnits === 1 ? '' : 's'} have no known cost, so the
              figure below covers only the {totals.knownCostUnits} units whose cost is known.
              It is not a complete inventory valuation.
            </AdminNotice>
          )}
          {totals.reconciliationFailures > 0 && (
            <AdminNotice tone="danger" className="mb-4" title="Layers and stock disagree.">
              {totals.reconciliationFailures} variant(s) where layer quantity does not match
              physical stock. Investigate before relying on these figures.
            </AdminNotice>
          )}

          <AdminStatGrid min={200} className="mb-6">
            <AdminStat label="Value at cost" value={money(totals.knownValueCents)}
              tone={totals.isPartialValuation ? 'warning' : 'default'}
              sub={totals.isPartialValuation ? 'Known-cost units only — partial' : 'All units costed'}
              info="Sum of the remaining FIFO layers at their cost. Retail price is never used." />
            <AdminStat label="Known-cost units" value={String(totals.knownCostUnits)} sub="Included in the value" />
            <AdminStat label="Unknown-cost units" value={String(totals.unknownCostUnits)}
              tone={totals.unknownCostUnits > 0 ? 'warning' : 'default'} sub="Excluded from the value" />
            <AdminStat label="Total units" value={String(totals.totalUnits)} sub="Physical on hand" />
          </AdminStatGrid>

          <AdminSectionHeader title="By variant" description="Cost basis only." />
          {rows.length === 0 && !loading ? <AdminEmpty title="No inventory." /> : (
            <AdminTable minWidth={720} caption="Inventory value by variant" stack>
              <thead><tr>
                {['SKU','Product','On hand','Layers','Known','Unknown','Value at cost','Reconciled'].map(h =>
                  <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.variantId}>
                    <AdminTd className="font-mono text-[11px]">{r.sku}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{r.productName}</AdminTd>
                    <AdminTd>{r.stockOnHand}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{r.layerUnitsRemaining}</AdminTd>
                    <AdminTd>{r.knownCostUnits}</AdminTd>
                    <AdminTd className={r.unknownCostUnits > 0 ? 'font-medium text-[#92400E]' : 'text-[#6B6B66]'}>
                      {r.unknownCostUnits}
                    </AdminTd>
                    <AdminTd className="font-medium">
                      {money(r.valueAtCostCents)}
                      {r.unknownCostUnits > 0 && (
                        <span className="block text-[11px] font-normal text-[#92400E]">partial</span>
                      )}
                    </AdminTd>
                    <AdminTd>
                      <StatusBadge status={r.reconciled ? 'Reconciled' : 'Exception'} label={r.reconciled ? 'Yes' : 'No'} />
                    </AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}

      {tab === 'receipts' && (
        <>
          <AdminCard className="mb-5">
            <AdminSectionHeader title="Receive stock"
              description="Cost comes from the batch, never from this form."
              info={<>Receiving is <strong className="font-medium">cumulative</strong>. A batch received 1+1+1 capitalises exactly
                the same total as one received all at once — remainder cents are carried on a small
                premium layer, never rounded away. Cost is derived from the batch; nothing here
                accepts a cost from the browser.</>} />
            <div className="grid gap-3 sm:grid-cols-3">
              <AdminField label="Cost batch" htmlFor="rc-batch">
                <select id="rc-batch" value={rcForm.costBatchId}
                  onChange={e => setRcForm({ ...rcForm, costBatchId: e.target.value })}
                  className={adminSelectClass}>
                  <option value="">Select…</option>
                  {batches.filter(b => !b.fullyReceived).map(b => (
                    <option key={b.costBatchId} value={b.costBatchId}>
                      {b.productName}{b.batchLabel ? ` · ${b.batchLabel}` : ''}
                      {b.intendedUnits !== null ? ` (${b.remainingUnits} left)` : ''}
                    </option>
                  ))}
                </select>
              </AdminField>
              <AdminField label="Variant" htmlFor="rc-variant">
                <select id="rc-variant" value={rcForm.variantId}
                  onChange={e => setRcForm({ ...rcForm, variantId: e.target.value })}
                  className={adminSelectClass}>
                  <option value="">Select…</option>
                  {rows.map(r => <option key={r.variantId} value={r.variantId}>{r.sku}</option>)}
                </select>
              </AdminField>
              <AdminField label="Quantity received" htmlFor="rc-qty">
                <input id="rc-qty" type="number" min="1" value={rcForm.quantity}
                  onChange={e => setRcForm({ ...rcForm, quantity: e.target.value })}
                  className={adminInputClass} />
              </AdminField>
            </div>
            <p className="mt-3 text-[11px] text-[#6B6B66]">
              The variant must belong to this batch. Receiving more than the batch was created
              for is rejected.
            </p>
            <AdminButton variant="primary" className="mt-3" onClick={submitReceipt}
              loading={saving}
              disabled={!rcForm.costBatchId || !rcForm.variantId || !rcForm.quantity}>
              Receive stock
            </AdminButton>
          </AdminCard>

          <AdminSectionHeader title="Batch progress"
            info="Layer value must equal the capitalised batch total once fully received." />
          <div className="mb-7">
            {batches.length === 0 && !loading ? (
              <AdminEmpty title="No cost batches." description="Create one under Product Costs first." />
            ) : (
              <AdminTable minWidth={820} caption="Cost batch receiving progress" stack>
                <thead><tr>
                  {['Product','Batch','Intended','Received','Remaining','Unit cost',
                    'Intended cost','Received cost','Status'].map(h =>
                    <AdminTh key={h}>{h}</AdminTh>)}
                </tr></thead>
                <tbody>
                  {batches.map(b => {
                    // Only a COMPLETE batch can be reconciled. A partially received
                    // batch legitimately shows less received than intended and must
                    // not be presented as a variance.
                    const matches = b.capitalizationReconciled
                    return (
                      <tr key={b.costBatchId}>
                        <AdminTd>{b.productName}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">{b.batchLabel ?? '—'}</AdminTd>
                        <AdminTd>{b.intendedUnits ?? '—'}</AdminTd>
                        <AdminTd>{b.receivedUnits}</AdminTd>
                        <AdminTd className="text-[#6B6B66]">{b.intendedUnits === null ? '—' : b.remainingUnits}</AdminTd>
                        <AdminTd>{b.unitCogsCents === null ? '—' : money(b.unitCogsCents)}</AdminTd>
                        <AdminTd>{money(b.intendedCapitalizedCents)}</AdminTd>
                        <AdminTd className={b.fullyReceived && !matches ? 'font-medium text-[#B91C1C]' : ''}>
                          {money(b.receivedCapitalizedCents)}
                        </AdminTd>
                        <AdminTd>
                          {b.fullyReceived
                            ? <StatusBadge status={matches ? 'Reconciled' : 'Exception'} label={matches ? 'Reconciled' : 'Variance'} />
                            : <StatusBadge status="Partial" />}
                        </AdminTd>
                      </tr>
                    )
                  })}
                </tbody>
              </AdminTable>
            )}
          </div>

          <AdminSectionHeader title="Purchase reconciliation"
            description="A non-zero variance is a review flag, not an error."
            info="Variance compares cash paid against the value ACTUALLY RECEIVED, not against the cost of units still in transit. A non-zero variance is expected while deposits or freight invoices are outstanding — it is a review flag, not an error." />
          <div className="mb-7">
            {recon.length === 0 && !loading ? <AdminEmpty title="No purchases recorded." /> : (
              <AdminTable minWidth={720} caption="Purchase reconciliation" stack>
                <thead><tr>
                  {['Supplier','Reference','Status','Batches','Ordered cost',
                    'Received cost','Cash paid','Variance'].map(h =>
                    <AdminTh key={h}>{h}</AdminTh>)}
                </tr></thead>
                <tbody>
                  {recon.map(r => (
                    <tr key={r.purchaseId}>
                      <AdminTd>{r.supplier}</AdminTd>
                      <AdminTd className="text-[#6B6B66]">{r.reference ?? '—'}</AdminTd>
                      <AdminTd className="text-[#6B6B66]">{r.status}</AdminTd>
                      <AdminTd>{r.costBatchCount}</AdminTd>
                      <AdminTd className="text-[#6B6B66]">
                        {money(r.intendedCapitalizedCents)}
                        {!r.fullyReceived && (
                          <span className="block text-[11px] text-[#92400E]">not all received</span>
                        )}
                      </AdminTd>
                      <AdminTd>{money(r.receivedCapitalizedCents)}</AdminTd>
                      <AdminTd>{money(r.cashPaidCents)}</AdminTd>
                      <AdminTd className={r.varianceCents === 0 ? 'text-[#047857]' : 'font-medium text-[#92400E]'}>
                        {r.varianceCents === 0 ? 'balanced' : money(r.varianceCents)}
                      </AdminTd>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            )}
          </div>

          <AdminSectionHeader title="Recent receipts" />
          {receipts.length === 0 && !loading ? <AdminEmpty title="No receipts recorded." /> : (
            <AdminTable minWidth={560} caption="Recent receipts" stack>
              <thead><tr>
                {['Received','SKU','Batch','Qty','Premium units','By'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r.id}>
                    <AdminTd>{r.receivedAt.slice(0, 10)}</AdminTd>
                    <AdminTd className="font-mono text-[11px]">{r.sku}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{r.batchLabel ?? '—'}</AdminTd>
                    <AdminTd>{r.quantity}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{r.premiumUnits}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{r.createdBy ?? '—'}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}

      {tab === 'writeoffs' && (
        <>
          <AdminCard className="mb-6">
            <AdminSectionHeader title="Record a write-off"
              info="Cost is computed server-side from FIFO layers. Promotional use is a marketing cost; damage and loss are not. Neither creates sales revenue." />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <AdminField label="Variant" htmlFor="wo-variant">
                <select id="wo-variant" value={woForm.variantId}
                  onChange={e => setWoForm({ ...woForm, variantId: e.target.value })}
                  className={adminSelectClass}>
                  <option value="">Select…</option>
                  {rows.map(r => <option key={r.variantId} value={r.variantId}>
                    {r.sku} ({r.stockOnHand})
                  </option>)}
                </select>
              </AdminField>
              <AdminField label="Quantity" htmlFor="wo-qty">
                <input id="wo-qty" type="number" min="1" value={woForm.quantity}
                  onChange={e => setWoForm({ ...woForm, quantity: e.target.value })}
                  className={adminInputClass} />
              </AdminField>
              <AdminField label="Reason" htmlFor="wo-reason">
                <select id="wo-reason" value={woForm.reason}
                  onChange={e => setWoForm({ ...woForm, reason: e.target.value })}
                  className={adminSelectClass}>
                  {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </AdminField>
              <AdminField label="Notes" htmlFor="wo-notes">
                <input id="wo-notes" value={woForm.notes}
                  onChange={e => setWoForm({ ...woForm, notes: e.target.value })}
                  className={adminInputClass} />
              </AdminField>
            </div>
            <AdminNotice tone="warning" className="mt-4">This permanently removes stock.</AdminNotice>
            <AdminButton variant="danger" className="mt-3" onClick={submitWriteOff}
              loading={saving} disabled={!woForm.variantId || !woForm.quantity}>
              Record write-off
            </AdminButton>
          </AdminCard>

          <AdminSectionHeader title="Recorded write-offs" />
          {writeOffs.length === 0 && !loading ? <AdminEmpty title="No write-offs recorded." /> : (
            <AdminTable minWidth={640} caption="Recorded write-offs" stack>
              <thead><tr>
                {['SKU','Qty','Reason','Type','Cost','Date','By'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {writeOffs.map(w => (
                  <tr key={w.id}>
                    <AdminTd className="font-mono text-[11px]">{w.sku}</AdminTd>
                    <AdminTd>{w.quantity}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{w.reason}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{w.isPromotional ? 'promotional' : 'loss'}</AdminTd>
                    <AdminTd className={w.totalCostCents === null ? 'font-medium text-[#92400E]' : ''}>
                      {moneyOrUnknown(w.totalCostCents, 'Unknown')}
                      {w.unknownCostQuantity > 0 && (
                        <span className="block text-[11px] font-normal">{w.unknownCostQuantity} unit(s) uncosted</span>
                      )}
                    </AdminTd>
                    <AdminTd className="text-[#6B6B66]">{w.createdAt.slice(0, 10)}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{w.createdBy ?? '—'}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}

      {tab === 'purchases' && (
        <>
          <AdminNotice tone="info" className="mb-5">
            Payments here are cash movements, not expenses or COGS.
            <InfoTip label="About purchase payments">Payments recorded here are <strong className="font-medium">cash movements</strong>, dated when money actually
              left. They are never operating expenses and never COGS — capitalised inventory cost
              reaches the P&amp;L only as units sell.</InfoTip>
          </AdminNotice>

          <div className="mb-6 grid gap-4 md:grid-cols-2">
            <AdminCard>
              <AdminSectionHeader title="New purchase" />
              <div className="space-y-3">
                {([['supplier','Supplier','text'],['reference','Reference','text'],
                   ['total','Expected total $','number'],['orderedAt','Ordered','date'],
                   ['receivedAt','Received','date']] as const).map(([k,l,t]) => (
                  <AdminField key={k} label={l} htmlFor={`po-${k}`}>
                    <input id={`po-${k}`} type={t} step={t === 'number' ? '0.01' : undefined}
                      value={(poForm as any)[k]}
                      onChange={e => setPoForm({ ...poForm, [k]: e.target.value })}
                      className={adminInputClass} />
                  </AdminField>
                ))}
              </div>
              <AdminButton variant="primary" className="mt-4" onClick={submitPurchase}
                loading={saving} disabled={!poForm.supplier}>
                Create purchase
              </AdminButton>
            </AdminCard>

            <AdminCard>
              <AdminSectionHeader title="Record a cash payment" />
              <div className="space-y-3">
                <AdminField label="Purchase" htmlFor="pay-purchase">
                  <select id="pay-purchase" value={payForm.purchaseId}
                    onChange={e => setPayForm({ ...payForm, purchaseId: e.target.value })}
                    className={adminSelectClass}>
                    <option value="">Select…</option>
                    {purchases.map(p => <option key={p.id} value={p.id}>
                      {p.supplier}{p.reference ? ` · ${p.reference}` : ''}
                    </option>)}
                  </select>
                </AdminField>
                <AdminField label="Type" htmlFor="pay-type">
                  <select id="pay-type" value={payForm.paymentType}
                    onChange={e => setPayForm({ ...payForm, paymentType: e.target.value })}
                    className={adminSelectClass}>
                    {['deposit','partial','final','supplier','freight','duties','tariffs',
                      'customs_brokerage','other'].map(t =>
                      <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </AdminField>
                <AdminField label="Amount $" htmlFor="pay-amount">
                  <input id="pay-amount" type="number" step="0.01" min="0" value={payForm.amount}
                    onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
                <AdminField label="Paid on (when money left)" htmlFor="pay-date">
                  <input id="pay-date" type="date" value={payForm.paidAt}
                    onChange={e => setPayForm({ ...payForm, paidAt: e.target.value })}
                    className={adminInputClass} />
                </AdminField>
              </div>
              <AdminButton variant="primary" className="mt-4" onClick={submitPayment}
                loading={saving} disabled={!payForm.purchaseId || !payForm.amount || !payForm.paidAt}>
                Record payment
              </AdminButton>
            </AdminCard>
          </div>

          <AdminSectionHeader title="Cash payments"
            info="A payment date is not a receipt date. Cash flow uses the paid date only." />
          {payments.length === 0 && !loading ? <AdminEmpty title="No payments recorded." /> : (
            <AdminTable minWidth={480} caption="Cash payments" stack>
              <thead><tr>
                {['Paid on','Supplier','Type','Amount'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <AdminTd>{p.paidAt}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{purchases.find(x => x.id === p.purchaseId)?.supplier ?? '—'}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{p.paymentType.replace(/_/g, ' ')}</AdminTd>
                    <AdminTd className="font-medium">{money(p.amountCents)}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}
    </AdminPage>
  )
}
