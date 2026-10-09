'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatCheckoutPrice } from '@/lib/format-money'
import {
  AdminPageHeader, AdminSectionHeader, AdminCard, AdminButton, AdminNotice, AdminTable, AdminTh, AdminTd,
  AdminEmpty, AdminLoading, AdminError, StatusBadge, adminInputClass,
} from '@/components/admin/ui/AdminUI'
import type { OrderTag, OrderTagChip } from '@/lib/order-tags'
import { FraudReviewPanel } from './FraudReviewPanel'
import { OrderTagsPanel, TagChip, ManageTags } from './OrderTagsPanel'
import { paymentBadge, fulfillmentBadge, listFraudBadge, CANCEL_WARNING } from './orders-ui'

// ── Types ──────────────────────────────────────────────────────────────────────

type FulfillmentStatus = 'unfulfilled'|'processing'|'shipped'|'delivered'|'cancelled'
type PaymentStatus     = 'pending'|'paid'|'failed'|'refunded'

interface OrderRow {
  id:                string
  orderNumber:       string
  paymentStatus:     PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  currency:          string
  subtotalCents:     number
  shippingCents:     number
  taxCents:          number
  discountCents:     number
  totalCents:        number
  shippingMethod:    string | null
  customerEmail:     string | null
  customerName:      string | null
  paidAt:            string | null
  createdAt:         string
  updatedAt:         string
  itemCount:         number
  quantityCount:     number
  tags?:             OrderTagChip[]
  fraud?:            { hold: 'none'|'active'|'released'; flagged: boolean; syncError: boolean } | null
}

interface OrderItem {
  id:             string
  sku:            string
  productName:    string
  color:          string
  size:           string
  quantity:       number
  unitPriceCents: number
  lineTotalCents: number
}

interface ShipmentInfo {
  id:             string
  carrier:        string | null
  trackingNumber: string | null
  shippedAt:      string | null
}

interface CancellationInfo {
  id:               string
  reason:           string
  cancelledBy:      string
  cancelledAt:      string
  restockedUnits:   number
  unknownCostUnits: number
  /** null = a restored unit's cost is UNKNOWN (never shown as $0). */
  cogsCreditCents:  number | null
}

interface OrderDetail extends OrderRow {
  customerPhone:   string | null
  shippingAddress: Record<string,string|null> | null
  items:           OrderItem[]
  shipment:        ShipmentInfo | null
  cancellation:    CancellationInfo | null
  tags:            OrderTagChip[]
  fraudHoldActive: boolean
  bundle?: {
    bundleId: string; setQuantity: number
    componentSubtotalCents: number; bundleDiscountCents: number; bundleNetCents: number
    lines: Array<{ orderItemId: string; sku: string; productName: string; quantity: number
      originalUnitPriceCents: number; allocatedDiscountCents: number; netLineCents: number }>
  } | null
}

interface Meta { total: number; limit: number; offset: number }

// ── Address renderer ───────────────────────────────────────────────────────────

function formatAddr(addr: Record<string,string|null> | null): string {
  if (!addr) return '—'
  const parts = [
    [addr.firstName, addr.lastName].filter(Boolean).join(' '),
    addr.line1,
    addr.line2 || null,
    [addr.city, addr.state, addr.postalCode].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean)
  return parts.join(', ') || '—'
}

const sel = `${adminInputClass} sm:w-auto`

// ── Main component ─────────────────────────────────────────────────────────────

export function AdminOrdersClient() {
  const [orders,    setOrders]    = useState<OrderRow[]>([])
  const [meta,      setMeta]      = useState<Meta>({ total:0, limit:50, offset:0 })
  const [detail,    setDetail]    = useState<OrderDetail | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error,     setError]     = useState('')
  const [search,    setSearch]    = useState('')
  const [payFilter, setPayFilter] = useState('')
  const [fulFilter, setFulFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [allTags,   setAllTags]   = useState<OrderTag[]>([])
  const [offset,    setOffset]    = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [txMsg,     setTxMsg]     = useState('')
  const [txOk,      setTxOk]      = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [carrier,   setCarrier]   = useState('')
  const [tracking,  setTracking]  = useState('')

  const LIMIT = 50

  const fetchOrders = useCallback(async (off = 0) => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ limit: String(LIMIT), offset: String(off) })
      if (search)    p.set('search', search)
      if (payFilter) p.set('paymentStatus', payFilter)
      if (fulFilter) p.set('fulfillmentStatus', fulFilter)
      if (tagFilter) p.set('tag', tagFilter)
      const res  = await fetch(`/api/orders?${p}`, { cache:'no-store' })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Failed.'); return }
      setOrders(json.data ?? [])
      setMeta(json.meta ?? { total:0, limit:LIMIT, offset:off })
      setOffset(off)
    } catch {
      setError('Network error.')
    } finally {
      setLoading(false)
    }
  }, [search, payFilter, fulFilter, tagFilter])

  useEffect(() => { fetchOrders(0) }, [fetchOrders])

  const loadTags = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/orders/tags', { cache: 'no-store' })
      if (res.ok) setAllTags((await res.json()).data ?? [])
    } catch { /* tags are optional: the page works without them */ }
  }, [])
  useEffect(() => { loadTags() }, [loadTags])

  const openDetail = async (id: string) => {
    setDetailLoading(true); setDetail(null); setTxMsg(''); setTxOk(false); setCancelReason('')
    try {
      const res  = await fetch(`/api/orders/${id}`, { cache:'no-store' })
      const json = await res.json()
      if (res.ok) setDetail(json.data)
      else setTxMsg(json.error ?? 'Couldn’t load this order.')
    } catch { setTxMsg('Couldn’t load this order.') } finally { setDetailLoading(false) }
  }

  /** Re-read the open order (e.g. after a hold is released) so action availability is current. */
  const reloadDetail = async () => {
    if (!detail) return
    try {
      const res  = await fetch(`/api/orders/${detail.id}`, { cache:'no-store' })
      const json = await res.json()
      if (res.ok) setDetail(json.data)
    } catch { /* keep what is shown */ }
    fetchOrders(offset)
  }

  const markProcessing = async () => {
    if (!detail) return
    if (!window.confirm(`Mark order ${detail.orderNumber} as processing?`)) return
    setTransitioning(true); setTxMsg(''); setTxOk(false)
    try {
      const res  = await fetch(`/api/orders/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ fulfillmentStatus:'processing' }),
      })
      const json = await res.json()
      if (res.ok) {
        setDetail(json.data)
        setTxOk(true)
        setTxMsg('Moved to processing.')
        fetchOrders(offset)
      } else {
        setTxMsg(json.error ?? 'Failed.')
        if (json.code === 'FRAUD_HOLD_ACTIVE') reloadDetail()
      }
    } catch {
      setTxMsg('Network error.')
    } finally { setTransitioning(false) }
  }

  const markShipped = async () => {
    if (!detail) return
    const trimCarrier  = carrier.trim()
    const trimTracking = tracking.trim()
    if (!trimCarrier)  { setTxMsg('Carrier is required.'); return }
    if (!trimTracking) { setTxMsg('Tracking number is required.'); return }
    if (!window.confirm(`Mark order ${detail.orderNumber} as shipped via ${trimCarrier}?`)) return
    setTransitioning(true); setTxMsg(''); setTxOk(false)
    try {
      const res  = await fetch(`/api/orders/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ fulfillmentStatus:'shipped', carrier:trimCarrier, trackingNumber:trimTracking }),
      })
      const json = await res.json()
      if (res.ok) {
        setDetail(json.data)
        setCarrier(''); setTracking('')
        setTxOk(true)
        setTxMsg('Order marked shipped.')
        fetchOrders(offset)
      } else {
        setTxMsg(json.error ?? 'Failed.')
        if (json.code === 'FRAUD_HOLD_ACTIVE') reloadDetail()
      }
    } catch {
      setTxMsg('Network error.')
    } finally { setTransitioning(false) }
  }

  /**
   * Cancel a FULLY REFUNDED, NEVER-SHIPPED order and put its units back in stock.
   * The server and database re-check everything; this only asks for an explicit confirmation.
   */
  const cancelUnshipped = async () => {
    if (!detail) return
    const reason = cancelReason.trim()
    if (reason.length < 3) { setTxOk(false); setTxMsg('Enter a reason (at least 3 characters).'); return }
    if (!window.confirm(
      `Cancel order ${detail.orderNumber} and restore its inventory?\n\n` +
      `${CANCEL_WARNING} It does not create a return or a shipment.`
    )) return
    setTransitioning(true); setTxMsg(''); setTxOk(false)
    try {
      const res  = await fetch(`/api/orders/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ fulfillmentStatus:'cancelled', reason, confirm:true }),
      })
      const json = await res.json()
      if (res.ok) {
        setDetail(json.data)
        setCancelReason('')
        setTxOk(true)
        setTxMsg(json.outcome === 'already_cancelled'
          ? 'This order was already cancelled; nothing was changed.'
          : 'Order cancelled and inventory restored.')
        fetchOrders(offset)
      } else {
        setTxMsg(json.error ?? 'Failed.')
      }
    } catch {
      setTxMsg('Network error.')
    } finally { setTransitioning(false) }
  }

  const onDetailTags = (tags: OrderTagChip[]) => {
    if (!detail) return
    setDetail({ ...detail, tags })
    setOrders(os => os.map(o => (o.id === detail.id ? { ...o, tags } : o)))
    loadTags()                                   // order counts in the tag manager
    if (tagFilter) fetchOrders(offset)           // a removed tag can drop the order out of a filtered list
  }

  const totalPages = Math.ceil(meta.total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT) + 1
  const fraudHeld = !!detail?.fraudHoldActive

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">

      <AdminPageHeader
        title="Orders"
        description="Search, review, and fulfill orders."
        eyebrow="Workspace"
        actions={<span className="rounded-full border border-black/[0.08] bg-white px-3 py-1 text-[11px] text-[#6B6B66]">{meta.total} total</span>}
      />

      {/* Filters */}
      <AdminCard className="mb-4" padded={false}>
        <div className="flex flex-col gap-2 p-3 lg:flex-row">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchOrders(0)}
            placeholder="Order #, customer name, or email"
            aria-label="Search orders"
            className={`${adminInputClass} min-w-0 flex-1`}
          />
          <select aria-label="Payment status" value={payFilter} onChange={e => setPayFilter(e.target.value)} className={sel}>
            <option value="">All payments</option>
            {['pending','paid','failed','refunded'].map(v => (
              <option key={v} value={v}>{paymentBadge(v).status}</option>
            ))}
          </select>
          <select aria-label="Fulfillment status" value={fulFilter} onChange={e => setFulFilter(e.target.value)} className={sel}>
            <option value="">All fulfillment</option>
            {['unfulfilled','processing','shipped','delivered','cancelled'].map(v => (
              <option key={v} value={v}>{fulfillmentBadge(v).label ?? fulfillmentBadge(v).status}</option>
            ))}
          </select>
          <select aria-label="Tag" value={tagFilter} onChange={e => setTagFilter(e.target.value)} className={sel}>
            <option value="">All tags</option>
            {allTags.map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (archived)' : ''}</option>)}
          </select>
          <AdminButton variant="primary" onClick={() => fetchOrders(0)}>Search</AdminButton>
          <AdminButton onClick={() => { setSearch(''); setPayFilter(''); setFulFilter(''); setTagFilter('') }}>Clear</AdminButton>
        </div>
        {allTags.length > 0 && (
          <div className="border-t border-black/[0.06] px-3 py-1">
            <ManageTags tags={allTags} onChanged={() => { loadTags(); if (tagFilter) fetchOrders(0) }} />
          </div>
        )}
      </AdminCard>

      {error && <div className="mb-4"><AdminError message={error} onRetry={() => fetchOrders(offset)} /></div>}

      <div className="flex flex-col items-start gap-4 2xl:flex-row">

        {/* Orders list */}
        <section className="w-full min-w-0 flex-1">
          <AdminSectionHeader
            title="Order ledger"
            description={loading ? 'Updating…' : `${meta.total} order${meta.total === 1 ? '' : 's'}`}
            actions={
              <AdminButton size="sm" onClick={() => fetchOrders(offset)} disabled={loading} aria-label="Refresh orders">Refresh</AdminButton>
            }
          />

          {loading ? (
            <AdminLoading label="Loading orders…" />
          ) : orders.length === 0 && !error ? (
            <AdminEmpty title="No orders found." />
          ) : (
            <AdminTable caption="Orders" stack>
              <thead>
                <tr>
                  {['Order','Date','Customer','Items','Total','Payment','Fulfillment','Tags','Shipping'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const pay = paymentBadge(o.paymentStatus)
                  const ful = fulfillmentBadge(o.fulfillmentStatus)
                  const fr  = listFraudBadge(o.fraud)
                  return (
                    <tr key={o.id} onClick={() => openDetail(o.id)}
                      className={['cursor-pointer hover:bg-black/[0.018]', detail?.id === o.id ? 'bg-black/[0.025]' : ''].join(' ')}>
                      <AdminTd className="whitespace-nowrap">
                        <button type="button" onClick={e => { e.stopPropagation(); openDetail(o.id) }}
                          className="font-mono text-[11px] font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40">
                          {o.orderNumber}
                        </button>
                      </AdminTd>
                      <AdminTd className="whitespace-nowrap text-[#6B6B66]">
                        {new Date(o.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' })}
                      </AdminTd>
                      <AdminTd className="max-w-[220px]">
                        <p className="truncate font-medium">{o.customerName ?? '—'}</p>
                        <p className="mt-0.5 truncate text-[11px] text-[#8A8A85]">{o.customerEmail ?? ''}</p>
                      </AdminTd>
                      <AdminTd className="text-center">{o.quantityCount}</AdminTd>
                      <AdminTd className="whitespace-nowrap font-medium">{formatCheckoutPrice(o.totalCents)}</AdminTd>
                      <AdminTd><StatusBadge {...pay} /></AdminTd>
                      <AdminTd>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge {...ful} />
                          {fr && <StatusBadge {...fr} />}
                        </div>
                      </AdminTd>
                      <AdminTd>
                        <div className="flex max-w-[200px] flex-wrap gap-1">
                          {(o.tags ?? []).map(t => <TagChip key={t.id} tag={t} />)}
                        </div>
                      </AdminTd>
                      <AdminTd className="whitespace-nowrap text-[#6B6B66]">{o.shippingMethod ?? '—'}</AdminTd>
                    </tr>
                  )
                })}
              </tbody>
            </AdminTable>
          )}

          {meta.total > LIMIT && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-[#8A8A85]">Page {currentPage} of {totalPages} · {meta.total} orders</p>
              <div className="flex gap-2">
                <AdminButton size="sm" onClick={() => fetchOrders(Math.max(0, offset - LIMIT))} disabled={offset === 0}>← Previous</AdminButton>
                <AdminButton size="sm" onClick={() => fetchOrders(offset + LIMIT)} disabled={offset + LIMIT >= meta.total}>Next →</AdminButton>
              </div>
            </div>
          )}
        </section>

        {/* Order detail */}
        {(detailLoading || detail) && (
          <aside aria-label="Order detail" className="w-full flex-shrink-0 overflow-hidden rounded-[14px] border border-black/[0.08] bg-white 2xl:sticky 2xl:top-6 2xl:w-[400px]">
            {detailLoading ? (
              <div className="px-5 py-8"><AdminLoading label="Loading order…" /></div>
            ) : detail ? (
              <>
                <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#8A8A85]">Order detail</p>
                    <h2 className="mt-1 font-mono text-[13px] font-medium">{detail.orderNumber}</h2>
                  </div>
                  <AdminButton size="sm" variant="ghost" aria-label="Close order details"
                    onClick={() => { setDetail(null); setTxMsg('') }}>Close</AdminButton>
                </div>

                <div className="max-h-[calc(100vh-120px)] space-y-4 overflow-y-auto px-5 py-5">
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge {...paymentBadge(detail.paymentStatus)} />
                    <StatusBadge {...fulfillmentBadge(detail.fulfillmentStatus)} />
                    {fraudHeld && <StatusBadge status="Held" />}
                  </div>

                  <div className="rounded-[10px] bg-[#F8F8F6] px-3.5 py-2.5">
                    {detail.paidAt && <Row label="Paid">{new Date(detail.paidAt).toLocaleString()}</Row>}
                    <Row label="Created">{new Date(detail.createdAt).toLocaleString()}</Row>
                  </div>

                  <FraudReviewPanel
                    orderId={detail.id}
                    orderNumber={detail.orderNumber}
                    paymentStatus={detail.paymentStatus}
                    fulfillmentStatus={detail.fulfillmentStatus}
                    onChanged={reloadDetail}
                  />

                  <OrderTagsPanel
                    orderId={detail.id}
                    tags={detail.tags ?? []}
                    allTags={allTags}
                    onChanged={onDetailTags}
                    onTagsCatalogChanged={loadTags}
                  />

                  <section>
                    <AdminSectionHeader title="Customer" />
                    <Row label="Name">{detail.customerName ?? '—'}</Row>
                    <Row label="Email">{detail.customerEmail ?? '—'}</Row>
                    {detail.customerPhone && <Row label="Phone">{detail.customerPhone}</Row>}
                    <Row label="Address">{formatAddr(detail.shippingAddress)}</Row>
                    {detail.shippingMethod && <Row label="Shipping">{detail.shippingMethod}</Row>}
                  </section>

                  <section>
                    <AdminSectionHeader title="Items" />
                    {detail.bundle && (
                      <div data-order-set className="mb-2 rounded-[10px] border border-black/[0.08] px-3.5 py-2.5 text-[12px]">
                        <p className="font-medium text-[#3A3A38]">
                          Complete the Set{detail.bundle.setQuantity > 1 ? ` × ${detail.bundle.setQuantity}` : ''}
                        </p>
                        <div className="mt-1.5 space-y-0.5 text-[11px] text-[#6B6B68]">
                          {detail.bundle.lines.map(l => (
                            <div key={l.orderItemId} className="flex justify-between gap-3">
                              <span className="min-w-0 flex-1">{l.productName}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</span>
                              <span>
                                {formatCheckoutPrice(l.originalUnitPriceCents * l.quantity)}
                                {l.allocatedDiscountCents > 0 && ` − ${formatCheckoutPrice(l.allocatedDiscountCents)}`}
                                {' = '}{formatCheckoutPrice(l.netLineCents)}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-1.5 flex justify-between border-t border-black/[0.06] pt-1.5 text-[11px]">
                          <span>Separately {formatCheckoutPrice(detail.bundle.componentSubtotalCents)}, set savings −{formatCheckoutPrice(detail.bundle.bundleDiscountCents)}</span>
                          <span className="font-medium text-[#3A3A38]">{formatCheckoutPrice(detail.bundle.bundleNetCents)}</span>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      {detail.items.map(item => (
                        <div key={item.id} className="flex justify-between gap-3 rounded-[10px] bg-[#F8F8F6] px-3.5 py-2.5 text-[12px]">
                          <span className="min-w-0 flex-1 text-[#3A3A38]">
                            {item.productName}
                            <span className="mt-0.5 block text-[11px] text-[#8A8A85]">
                              {item.color} / {item.size}{item.quantity > 1 && ` × ${item.quantity}`}
                              {detail.bundle?.lines.some(l => l.orderItemId === item.id) && ' · part of set'}
                            </span>
                          </span>
                          <span className="flex-shrink-0 font-medium">{formatCheckoutPrice(item.lineTotalCents)}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <AdminSectionHeader title="Payment summary" />
                    <Row label="Subtotal">{formatCheckoutPrice(detail.subtotalCents)}</Row>
                    <Row label="Shipping">{formatCheckoutPrice(detail.shippingCents)}</Row>
                    {detail.taxCents > 0 && <Row label="Tax">{formatCheckoutPrice(detail.taxCents)}</Row>}
                    {detail.discountCents > 0 && <Row label="Discount">−{formatCheckoutPrice(detail.discountCents)}</Row>}
                    <Row label="Total" bold>{formatCheckoutPrice(detail.totalCents)}</Row>
                  </section>

                  {detail.paymentStatus === 'refunded'
                    && (detail.fulfillmentStatus === 'unfulfilled' || detail.fulfillmentStatus === 'processing')
                    && !detail.shipment && (
                    <section>
                      <AdminSectionHeader
                        title="Refunded before shipment"
                        info={<>Cancelling puts the sold units back in stock at their original cost and settles the order’s cost. It does not create a return or a shipment. The server re-checks eligibility.</>}
                      />
                      <AdminNotice tone="warning" className="mb-2">{CANCEL_WARNING}</AdminNotice>
                      <input
                        value={cancelReason}
                        onChange={e => setCancelReason(e.target.value)}
                        maxLength={500}
                        placeholder="Reason (required)"
                        aria-label="Cancellation reason"
                        className={`${adminInputClass} mb-2`}
                      />
                      <AdminButton variant="danger" className="w-full"
                        onClick={cancelUnshipped}
                        disabled={transitioning || cancelReason.trim().length < 3}>
                        {transitioning ? 'Cancelling…' : 'Cancel unshipped order & restore inventory'}
                      </AdminButton>
                    </section>
                  )}

                  {detail.cancellation && (
                    <section>
                      <AdminSectionHeader title="Cancelled before shipment" />
                      <Row label="Units restocked">{detail.cancellation.restockedUnits}</Row>
                      <Row label="COGS credit">
                        {detail.cancellation.cogsCreditCents === null
                          ? 'Unknown'
                          : formatCheckoutPrice(detail.cancellation.cogsCreditCents)}
                      </Row>
                      <Row label="Cancelled">{new Date(detail.cancellation.cancelledAt).toLocaleString()}</Row>
                      <Row label="Reason">{detail.cancellation.reason}</Row>
                    </section>
                  )}

                  {fraudHeld && detail.paymentStatus !== 'refunded'
                    && (detail.fulfillmentStatus === 'unfulfilled' || detail.fulfillmentStatus === 'processing') && (
                    <AdminNotice tone="warning" title="Fulfillment is blocked by the fraud hold.">
                      Release the hold above to continue.
                    </AdminNotice>
                  )}

                  {detail.paymentStatus !== 'refunded' && detail.fulfillmentStatus === 'unfulfilled' && !fraudHeld && (
                    <AdminButton variant="primary" className="w-full" onClick={markProcessing} disabled={transitioning}>
                      {transitioning ? 'Updating…' : 'Mark processing'}
                    </AdminButton>
                  )}

                  {detail.paymentStatus !== 'refunded' && detail.fulfillmentStatus === 'processing' && !fraudHeld && (
                    <section>
                      <AdminSectionHeader title="Shipment" />
                      <div className="space-y-2">
                        <select aria-label="Carrier" value={carrier} onChange={e => setCarrier(e.target.value)} className={adminInputClass}>
                          <option value="">Carrier *</option>
                          {['USPS','UPS','FedEx','DHL','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input value={tracking} onChange={e => setTracking(e.target.value)} placeholder="Tracking number *"
                          aria-label="Tracking number" className={adminInputClass} />
                        <AdminButton variant="primary" className="w-full" onClick={markShipped} disabled={transitioning}>
                          {transitioning ? 'Saving…' : 'Confirm shipment'}
                        </AdminButton>
                      </div>
                    </section>
                  )}

                  {detail.shipment && (
                    <section>
                      <AdminSectionHeader title="Tracking" />
                      <Row label="Carrier">{detail.shipment.carrier ?? '—'}</Row>
                      <Row label="Tracking">{detail.shipment.trackingNumber ?? '—'}</Row>
                      {detail.shipment.shippedAt && (
                        <Row label="Shipped">{new Date(detail.shipment.shippedAt).toLocaleString()}</Row>
                      )}
                    </section>
                  )}

                  {txMsg && <AdminNotice tone={txOk ? 'success' : 'danger'}>{txMsg}</AdminNotice>}
                </div>
              </>
            ) : null}
            {!detailLoading && !detail && txMsg && <div className="p-4"><AdminNotice tone="danger">{txMsg}</AdminNotice></div>}
          </aside>
        )}
      </div>
    </div>
  )
}

// ── Layout helper ──────────────────────────────────────────────────────────────

function Row({ label, children, bold }: { label:string; children:React.ReactNode; bold?:boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-[3px] text-[12px]">
      <span className="shrink-0 text-[#8A8A85]">{label}</span>
      <span className={`min-w-0 text-right ${bold ? 'font-semibold' : ''}`}>{children}</span>
    </div>
  )
}
