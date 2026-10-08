'use client'
// app/admin/financials/shipping/ShippingClient.tsx
// Shipping economics. The whole point of this page is to keep two numbers apart:
//   REVENUE = what the customer paid KVRN for shipping (orders.shipping_cents)
//   COST    = what KVRN paid the carrier      (shipments.label_cost_cents)

import { useEffect, useState, useCallback } from 'react'
import {
  money, moneyOrUnknown,
  Metric, RangePicker, buildQuery,
} from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminNotice, AdminButton, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminTag, adminInputClass,
} from '@/components/admin/ui/AdminUI'

type Totals = {
  orders: number
  ordersWithKnownCost: number
  ordersMissingCost: number
  shippingRevenueCents: number
  shippingDiscountCents: number
  shippingCostCents: number
  shippingMarginCents: number
  shippingSubsidyCents: number
  freeShippingOrders: number
  freeShippingCostCents: number
  ordersUnderwater: number
  ordersProfitable: number
}

type PendingCost = {
  shipmentId: string; orderId: string; orderNumber: string
  shippingRevenueCents: number
  carrier: string | null; trackingNumber: string | null
  serviceLevel: string | null; shippedAt: string | null
}

type Row = {
  orderId: string
  orderNumber: string
  paidAt: string | null
  shippingRevenueCents: number
  shippingCostCents: number | null
  shippingMarginCents: number | null
  isAutoFreeShipping: boolean
  shippingDiscountTotalCents: number
}

export function ShippingClient() {
  const [range, setRange]   = useState('30d')
  const [custom, setCustom] = useState({ start: '', end: '' })
  const [data, setData]     = useState<{ totals: Totals; orders: Row[]; pendingCost: PendingCost[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)
  // Manual label-cost entry state, keyed by shipment id
  const [costDraft, setCostDraft] = useState<Record<string, string>>({})
  const [savingId, setSavingId]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res  = await fetch(`/api/admin/financials/shipping${buildQuery(range, custom)}`)
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load shipping economics.'); return }
      setData(json)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [range, custom])

  useEffect(() => { void load() }, [load])

  /**
   * Record the ACTUAL carrier cost for a shipment.
   *
   * This is KVRN's cost, not what the customer paid. Until it is entered the
   * order reports shipping margin as unknown rather than assuming zero, so this
   * form is what makes shipping economics computable today. When Shippo label
   * purchasing is automated the same column is populated with
   * cost_source='shippo_label' instead.
   */
  async function saveLabelCost(shipmentId: string) {
    const raw = (costDraft[shipmentId] ?? '').trim()
    if (!raw) return
    const cents = Math.round(parseFloat(raw) * 100)
    if (!Number.isFinite(cents) || cents < 0) { setErr('Enter a valid label cost.'); return }

    setSavingId(shipmentId); setErr(null)
    try {
      const res = await fetch(`/api/admin/shipments/${shipmentId}/cost`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelCostCents: cents, costSource: 'manual' }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save label cost.'); return }
      setCostDraft(d => { const n = { ...d }; delete n[shipmentId]; return n })
      await load()
    } catch { setErr('Network error.') }
    finally { setSavingId(null) }
  }

  const t = data?.totals

  return (
    <AdminPage>
      <AdminPageHeader
        title="Shipping"
        description="Shipping revenue, carrier cost, and margin."
        info="Shipping revenue is what customers paid. Shipping cost is what KVRN paid the carrier. A negative margin means KVRN subsidised delivery."
      />

      <div className="mb-5">
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && !data && <AdminLoading />}

      {t && (
        <>
          {t.ordersMissingCost > 0 && (
            <AdminNotice tone="warning" className="mb-4" title={`${t.ordersMissingCost} of ${t.orders} orders have no recorded label cost.`}>
              Margin and subsidy below cover only the {t.ordersWithKnownCost} orders where the
              actual carrier cost is known.
            </AdminNotice>
          )}

          <AdminSectionHeader title="Totals" />
          <AdminStatGrid className="mb-7">
            <Metric label="Shipping revenue" value={money(t.shippingRevenueCents)}
                    sub="Charged to customers" />
            <Metric label="Shipping discounts" value={`-${money(t.shippingDiscountCents)}`} tone="muted"
                    sub="Auto free + promo codes" />
            <Metric label="Actual carrier cost" value={money(t.shippingCostCents)}
                    sub={`${t.ordersWithKnownCost} orders known`}
                    pending={t.ordersMissingCost > 0} />
            <Metric label="Shipping margin" value={money(t.shippingMarginCents)}
                    tone={t.shippingMarginCents >= 0 ? 'positive' : 'negative'}
                    sub="Revenue − cost" />
            <Metric label="Subsidised" value={money(t.shippingSubsidyCents)} tone="negative"
                    sub={`${t.ordersUnderwater} orders below cost`}
                    info="Carrier cost above what the customer paid, summed over orders where the cost is known." />
            <Metric label="Free shipping cost" value={money(t.freeShippingCostCents)} tone="muted"
                    sub={`${t.freeShippingOrders} free-shipping orders`} />
          </AdminStatGrid>

          {/* Manual label-cost worklist — makes shipping margin computable */}
          {data!.pendingCost.length > 0 && (
            <div className="mb-7">
              <AdminSectionHeader title={`Label cost not recorded (${data!.pendingCost.length})`}
                description="Enter the real carrier cost. Until then margin is unknown, not $0."
                info="KVRN does not purchase labels programmatically yet. Until the real carrier cost is entered here, these orders report shipping margin as unknown rather than assuming zero." />
              <AdminTable minWidth={720} caption="Shipments without a label cost">
                <thead>
                  <tr>
                    {['Order', 'Carrier', 'Service', 'Tracking', 'Customer paid', 'Actual label cost'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                    <AdminTh><span className="sr-only">Save</span></AdminTh>
                  </tr>
                </thead>
                <tbody>
                  {data!.pendingCost.map(p2 => (
                    <tr key={p2.shipmentId}>
                      <AdminTd>{p2.orderNumber}</AdminTd>
                      <AdminTd className="text-[#6B6B66]">{p2.carrier ?? '—'}</AdminTd>
                      <AdminTd className="text-[#6B6B66]">{p2.serviceLevel ?? '—'}</AdminTd>
                      <AdminTd className="font-mono text-[11px] text-[#6B6B66]">{p2.trackingNumber ?? '—'}</AdminTd>
                      <AdminTd>{money(p2.shippingRevenueCents)}</AdminTd>
                      <AdminTd>
                        <input
                          type="number" step="0.01" min="0"
                          value={costDraft[p2.shipmentId] ?? ''}
                          onChange={e => setCostDraft(d => ({ ...d, [p2.shipmentId]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') void saveLabelCost(p2.shipmentId) }}
                          placeholder="0.00"
                          aria-label={`Actual label cost for ${p2.orderNumber}`}
                          className={`${adminInputClass} !w-[96px]`}
                        />
                      </AdminTd>
                      <AdminTd>
                        <AdminButton
                          variant="primary" size="sm"
                          onClick={() => void saveLabelCost(p2.shipmentId)}
                          disabled={!(costDraft[p2.shipmentId] ?? '').trim()}
                          loading={savingId === p2.shipmentId}>
                          Save
                        </AdminButton>
                      </AdminTd>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            </div>
          )}

          <AdminSectionHeader title="Per order"
            description="Revenue against carrier cost for each paid order." />
          <AdminTable minWidth={640} caption="Shipping by order">
            <thead>
              <tr>
                {['Order', 'Paid', 'Charged', 'Discount', 'Carrier cost', 'Margin'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                <AdminTh><span className="sr-only">Notes</span></AdminTh>
              </tr>
            </thead>
            <tbody>
              {data!.orders.length === 0 && (
                <tr><AdminTd colSpan={7} className="text-[#6B6B66]">No paid orders in this period.</AdminTd></tr>
              )}
              {data!.orders.map(o => (
                <tr key={o.orderId}>
                  <AdminTd>{o.orderNumber}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">
                    {o.paidAt ? new Date(o.paidAt).toISOString().slice(0, 10) : '—'}
                  </AdminTd>
                  <AdminTd>{money(o.shippingRevenueCents)}</AdminTd>
                  <AdminTd className="text-[#6B6B66]">
                    {o.shippingDiscountTotalCents > 0 ? `-${money(o.shippingDiscountTotalCents)}` : '—'}
                  </AdminTd>
                  <AdminTd className={o.shippingCostCents === null ? 'font-medium text-[#92400E]' : ''}>
                    {moneyOrUnknown(o.shippingCostCents, 'Not recorded')}
                  </AdminTd>
                  <AdminTd className={o.shippingMarginCents === null ? 'text-[#6B6B66]'
                                    : o.shippingMarginCents >= 0 ? 'text-[#047857]' : 'text-[#B91C1C]'}>
                    {moneyOrUnknown(o.shippingMarginCents, '—')}
                  </AdminTd>
                  <AdminTd>{o.isAutoFreeShipping && <AdminTag tone="info">Free ship</AdminTag>}</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}
    </AdminPage>
  )
}
