'use client'
// app/admin/financials/shipping/ShippingClient.tsx
// Shipping economics. The whole point of this page is to keep two numbers apart:
//   REVENUE = what the customer paid KVRN for shipping (orders.shipping_cents)
//   COST    = what KVRN paid the carrier      (shipments.label_cost_cents)

import { useEffect, useState, useCallback } from 'react'
import {
  FONT, BORDER, money, moneyOrUnknown,
  Metric, RangePicker, SectionTitle, buildQuery,
} from '@/components/admin/FinancialUI'

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
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Shipping economics
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Shipping revenue is what customers paid. Shipping cost is what KVRN paid the carrier.
        A negative margin means KVRN subsidised delivery.
      </p>

      <div style={{ marginBottom: 22 }}>
        <RangePicker range={range} onRange={setRange} custom={custom} onCustom={setCustom} />
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && !data && (
        <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>Loading…</p>
      )}

      {t && (
        <>
          {t.ordersMissingCost > 0 && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                          border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 18 }}>
              {t.ordersMissingCost} of {t.orders} orders have no recorded label cost.
              Margin and subsidy below cover only the {t.ordersWithKnownCost} orders where the
              actual carrier cost is known.
            </div>
          )}

          <SectionTitle>Totals</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                        gap: 10, marginBottom: 26 }}>
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
                    sub={`${t.ordersUnderwater} orders below cost`} />
            <Metric label="Free shipping cost" value={money(t.freeShippingCostCents)} tone="muted"
                    sub={`${t.freeShippingOrders} free-shipping orders`} />
          </div>

          {/* Manual label-cost worklist — makes shipping margin computable */}
          {data!.pendingCost.length > 0 && (
            <>
              <SectionTitle note="KVRN does not purchase labels programmatically yet. Until the real carrier cost is entered here, these orders report shipping margin as unknown rather than assuming zero.">
                Label cost not recorded ({data!.pendingCost.length})
              </SectionTitle>
              <div style={{ border: BORDER, background: '#fff', overflowX: 'auto', marginBottom: 26 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#FAF9F7' }}>
                      {['Order', 'Carrier', 'Service', 'Tracking', 'Customer paid', 'Actual label cost', ''].map((h, i) => (
                        <th key={i} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                             letterSpacing: '0.1em', textTransform: 'uppercase',
                                             color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data!.pendingCost.map(p2 => (
                      <tr key={p2.shipmentId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                        <td style={{ padding: '9px 12px' }}>{p2.orderNumber}</td>
                        <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{p2.carrier ?? '—'}</td>
                        <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{p2.serviceLevel ?? '—'}</td>
                        <td style={{ padding: '9px 12px', color: '#6B6B6B', fontFamily: 'monospace', fontSize: 11 }}>
                          {p2.trackingNumber ?? '—'}
                        </td>
                        <td style={{ padding: '9px 12px' }}>{money(p2.shippingRevenueCents)}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <input
                            type="number" step="0.01" min="0"
                            value={costDraft[p2.shipmentId] ?? ''}
                            onChange={e => setCostDraft(d => ({ ...d, [p2.shipmentId]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') void saveLabelCost(p2.shipmentId) }}
                            placeholder="0.00"
                            aria-label={`Actual label cost for ${p2.orderNumber}`}
                            style={{ width: 90, padding: '6px 8px', fontSize: 12,
                                     border: BORDER, background: '#fff', fontFamily: FONT }}
                          />
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <button
                            onClick={() => void saveLabelCost(p2.shipmentId)}
                            disabled={savingId === p2.shipmentId || !(costDraft[p2.shipmentId] ?? '').trim()}
                            style={{ fontFamily: FONT, fontSize: 10, fontWeight: 500,
                                     letterSpacing: '0.08em', textTransform: 'uppercase',
                                     padding: '7px 12px', background: '#1A1A1A', color: '#fff',
                                     border: 'none', cursor: 'pointer',
                                     opacity: savingId === p2.shipmentId || !(costDraft[p2.shipmentId] ?? '').trim() ? 0.4 : 1 }}>
                            {savingId === p2.shipmentId ? '…' : 'Save'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <SectionTitle note="Orders where shipping revenue exceeded or fell short of actual carrier cost.">
            Per order
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#FAF9F7' }}>
                  {['Order', 'Paid', 'Charged', 'Discount', 'Carrier cost', 'Margin', ''].map((h, i) => (
                    <th key={i} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                         letterSpacing: '0.1em', textTransform: 'uppercase',
                                         color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.orders.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No paid orders in this period.
                  </td></tr>
                )}
                {data!.orders.map(o => (
                  <tr key={o.orderId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 12px' }}>{o.orderNumber}</td>
                    <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                      {o.paidAt ? new Date(o.paidAt).toISOString().slice(0, 10) : '—'}
                    </td>
                    <td style={{ padding: '9px 12px' }}>{money(o.shippingRevenueCents)}</td>
                    <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                      {o.shippingDiscountTotalCents > 0 ? `-${money(o.shippingDiscountTotalCents)}` : '—'}
                    </td>
                    <td style={{ padding: '9px 12px',
                                 color: o.shippingCostCents === null ? '#92400E' : '#1A1A1A' }}>
                      {moneyOrUnknown(o.shippingCostCents, 'Not recorded')}
                    </td>
                    <td style={{ padding: '9px 12px',
                                 color: o.shippingMarginCents === null ? '#6B7280'
                                      : o.shippingMarginCents >= 0 ? '#047857' : '#B91C1C' }}>
                      {moneyOrUnknown(o.shippingMarginCents, '—')}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      {o.isAutoFreeShipping && (
                        <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                                       padding: '3px 8px', background: '#EFF6FF',
                                       border: '1px solid #BFDBFE', color: '#1E40AF' }}>
                          Free ship
                        </span>
                      )}
                    </td>
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
