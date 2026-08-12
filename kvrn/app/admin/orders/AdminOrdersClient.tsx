'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatCheckoutPrice } from '@/lib/format-money'

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

interface OrderDetail extends OrderRow {
  customerPhone:   string | null
  shippingAddress: Record<string,string|null> | null
  items:           OrderItem[]
  shipment:        ShipmentInfo | null
}

interface Meta { total: number; limit: number; offset: number }

// ── Status badge colours ───────────────────────────────────────────────────────

const PAYMENT_COLOURS: Record<string, string> = {
  paid:     '#059669', pending:  '#D97706',
  failed:   '#DC2626', refunded: '#6B7280',
}
const FULFILL_COLOURS: Record<string, string> = {
  unfulfilled: '#D97706', processing:  '#2563EB',
  shipped:     '#059669', delivered:   '#059669',
  cancelled:   '#6B7280',
}

function Badge({ text, colour }: { text: string; colour: string }) {
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:2,
      fontSize:11, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase',
      background: colour + '18', color: colour, border:`1px solid ${colour}40`,
    }}>
      {text}
    </span>
  )
}

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
  const [offset,    setOffset]    = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [txMsg,     setTxMsg]     = useState('')
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
  }, [search, payFilter, fulFilter])

  useEffect(() => { fetchOrders(0) }, [fetchOrders])

  const openDetail = async (id: string) => {
    setDetailLoading(true); setDetail(null); setTxMsg('')
    try {
      const res  = await fetch(`/api/orders/${id}`, { cache:'no-store' })
      const json = await res.json()
      if (res.ok) setDetail(json.data)
    } finally { setDetailLoading(false) }
  }

  const markProcessing = async () => {
    if (!detail) return
    if (!window.confirm(`Mark order ${detail.orderNumber} as processing?`)) return
    setTransitioning(true); setTxMsg('')
    try {
      const res  = await fetch(`/api/orders/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ fulfillmentStatus:'processing' }),
      })
      const json = await res.json()
      if (res.ok) {
        setDetail(json.data)
        setTxMsg('Moved to processing.')
        fetchOrders(offset)
      } else {
        setTxMsg(json.error ?? 'Failed.')
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
    setTransitioning(true); setTxMsg('')
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
        setTxMsg('Order marked shipped.')
        fetchOrders(offset)
      } else {
        setTxMsg(json.error ?? 'Failed.')
      }
    } catch {
      setTxMsg('Network error.')
    } finally { setTransitioning(false) }
  }

  const totalPages = Math.ceil(meta.total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT) + 1

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">

      {/* Page header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">
            Commerce
          </p>
          <h1 className="text-[30px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[34px]">
            Orders
          </h1>
          <p className="mt-2 text-[13px] text-black/45">
            Search, review, fulfill, and ship customer orders.
          </p>
        </div>

        <div className="rounded-full border border-black/[0.07] bg-white px-3.5 py-1.5 text-[11px] font-medium text-black/40 shadow-sm">
          {meta.total} total
        </div>
      </div>

      {/* Filters */}
      <div className="mb-5 rounded-xl border border-black/[0.07] bg-white p-3 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        <div className="flex flex-col gap-2.5 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <svg
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-black/25"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchOrders(0)}
              placeholder="Order #, customer name, or email"
              className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] pl-10 pr-3 text-[12px] text-[#171717] outline-none transition placeholder:text-black/25 focus:border-black/25 focus:bg-white"
            />
          </div>

          <select
            value={payFilter}
            onChange={e => setPayFilter(e.target.value)}
            className="h-10 rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] text-black/60 outline-none transition focus:border-black/25 focus:bg-white"
          >
            <option value="">All payments</option>
            {['pending','paid','failed','refunded'].map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          <select
            value={fulFilter}
            onChange={e => setFulFilter(e.target.value)}
            className="h-10 rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] text-black/60 outline-none transition focus:border-black/25 focus:bg-white"
          >
            <option value="">All fulfillment</option>
            {['unfulfilled','processing','shipped','delivered','cancelled'].map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          <button
            onClick={() => fetchOrders(0)}
            className="h-10 rounded-lg bg-[#111111] px-5 text-[11px] font-medium tracking-[0.04em] text-white transition hover:bg-black/80"
          >
            Search
          </button>

          <button
            onClick={() => {
              setSearch('')
              setPayFilter('')
              setFulFilter('')
            }}
            className="h-10 rounded-lg border border-black/[0.09] bg-white px-4 text-[11px] font-medium text-black/45 transition hover:border-black/20 hover:text-black"
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-col items-start gap-4 2xl:flex-row">

        {/* Orders list */}
        <section className="w-full min-w-0 flex-1 overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-black/30">
                Order ledger
              </p>
              <p className="mt-1 text-[12px] text-black/40">
                {loading ? 'Updating…' : `${meta.total} order${meta.total === 1 ? '' : 's'}`}
              </p>
            </div>

            <button
              onClick={() => fetchOrders(offset)}
              disabled={loading}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.07] text-black/35 transition hover:border-black/15 hover:text-black disabled:opacity-40"
              aria-label="Refresh orders"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                className={loading ? 'animate-spin' : ''}
                aria-hidden="true"
              >
                <path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
                  stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>

          {loading ? (
            <div className="px-6 py-14 text-center text-[12px] text-black/35">
              Loading orders…
            </div>
          ) : orders.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-[13px] font-medium text-black/55">No orders found</p>
              <p className="mt-1 text-[11px] text-black/30">
                Try changing your search or filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-[#FAFAF9]">
                    {['Order','Date','Customer','Items','Total','Payment','Fulfillment','Shipping',''].map(h => (
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
                  {orders.map(o => (
                    <tr
                      key={o.id}
                      onClick={() => openDetail(o.id)}
                      className={[
                        'cursor-pointer border-b border-black/[0.05] transition last:border-0 hover:bg-black/[0.018]',
                        detail?.id === o.id ? 'bg-black/[0.025]' : '',
                      ].join(' ')}
                    >
                      <td className="whitespace-nowrap px-4 py-4">
                        <span className="font-mono text-[11px] font-medium text-black/70">
                          {o.orderNumber}
                        </span>
                      </td>

                      <td className="whitespace-nowrap px-4 py-4 text-[11px] text-black/40">
                        {new Date(o.createdAt).toLocaleDateString('en-US', {
                          month:'short',
                          day:'numeric',
                          year:'2-digit',
                        })}
                      </td>

                      <td className="max-w-[220px] px-4 py-4">
                        <p className="truncate text-[12px] font-medium text-[#171717]">
                          {o.customerName ?? '—'}
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-black/30">
                          {o.customerEmail ?? ''}
                        </p>
                      </td>

                      <td className="px-4 py-4 text-center text-[12px] text-black/55">
                        {o.quantityCount}
                      </td>

                      <td className="whitespace-nowrap px-4 py-4 text-[12px] font-medium">
                        {formatCheckoutPrice(o.totalCents)}
                      </td>

                      <td className="px-4 py-4">
                        <Badge
                          text={o.paymentStatus}
                          colour={PAYMENT_COLOURS[o.paymentStatus] ?? '#6B7280'}
                        />
                      </td>

                      <td className="px-4 py-4">
                        <Badge
                          text={o.fulfillmentStatus}
                          colour={FULFILL_COLOURS[o.fulfillmentStatus] ?? '#6B7280'}
                        />
                      </td>

                      <td className="whitespace-nowrap px-4 py-4 text-[11px] text-black/40">
                        {o.shippingMethod ?? '—'}
                      </td>

                      <td className="px-4 py-4 text-right">
                        <span className="text-[11px] font-medium text-black/35">
                          View →
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {meta.total > LIMIT && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] px-5 py-4">
              <p className="text-[10px] text-black/30">
                Page {currentPage} of {totalPages} · {meta.total} orders
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => fetchOrders(Math.max(0, offset - LIMIT))}
                  disabled={offset === 0}
                  className="h-8 rounded-lg border border-black/[0.09] bg-white px-3 text-[10px] font-medium text-black/45 transition hover:border-black/20 hover:text-black disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ← Previous
                </button>

                <button
                  onClick={() => fetchOrders(offset + LIMIT)}
                  disabled={offset + LIMIT >= meta.total}
                  className="h-8 rounded-lg border border-black/[0.09] bg-white px-3 text-[10px] font-medium text-black/45 transition hover:border-black/20 hover:text-black disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Order detail */}
        {(detailLoading || detail) && (
          <aside className="w-full flex-shrink-0 overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.02)] 2xl:sticky 2xl:top-6 2xl:w-[390px]">
            {detailLoading ? (
              <div className="px-6 py-14 text-center text-[12px] text-black/35">
                Loading order…
              </div>
            ) : detail ? (
              <>
                <div className="flex items-start justify-between border-b border-black/[0.06] px-5 py-4">
                  <div>
                    <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                      Order detail
                    </p>
                    <h2 className="mt-1.5 font-mono text-[13px] font-medium">
                      {detail.orderNumber}
                    </h2>
                  </div>

                  <button
                    onClick={() => {
                      setDetail(null)
                      setTxMsg('')
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-black/30 transition hover:bg-black/[0.04] hover:text-black"
                    aria-label="Close order details"
                  >
                    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                      <path d="M3 3l12 12M15 3 3 15"
                        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                <div className="max-h-[calc(100vh-120px)] overflow-y-auto px-5 py-5">
                  <div className="flex flex-wrap gap-2 pb-4">
                    <Badge
                      text={detail.paymentStatus}
                      colour={PAYMENT_COLOURS[detail.paymentStatus] ?? '#6B7280'}
                    />
                    <Badge
                      text={detail.fulfillmentStatus}
                      colour={FULFILL_COLOURS[detail.fulfillmentStatus] ?? '#6B7280'}
                    />
                  </div>

                  <div className="rounded-lg bg-[#F8F8F6] p-4">
                    {detail.paidAt && (
                      <Row label="Paid">{new Date(detail.paidAt).toLocaleString()}</Row>
                    )}
                    <Row label="Created">{new Date(detail.createdAt).toLocaleString()}</Row>
                  </div>

                  <Divider />

                  <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                    Customer
                  </p>
                  <Row label="Name">{detail.customerName ?? '—'}</Row>
                  <Row label="Email">{detail.customerEmail ?? '—'}</Row>
                  {detail.customerPhone && <Row label="Phone">{detail.customerPhone}</Row>}
                  <Row label="Address">{formatAddr(detail.shippingAddress)}</Row>
                  {detail.shippingMethod && <Row label="Shipping">{detail.shippingMethod}</Row>}

                  <Divider />

                  <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                    Items
                  </p>

                  <div className="space-y-2">
                    {detail.items.map(item => (
                      <div
                        key={item.id}
                        className="flex justify-between gap-3 rounded-lg bg-[#F8F8F6] px-3.5 py-3 text-[11px]"
                      >
                        <span className="min-w-0 flex-1 text-black/65">
                          {item.productName}
                          <span className="block mt-0.5 text-[10px] text-black/30">
                            {item.color} / {item.size}
                            {item.quantity > 1 && ` × ${item.quantity}`}
                          </span>
                        </span>
                        <span className="flex-shrink-0 font-medium">
                          {formatCheckoutPrice(item.lineTotalCents)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <Divider />

                  <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                    Payment summary
                  </p>
                  <Row label="Subtotal">{formatCheckoutPrice(detail.subtotalCents)}</Row>
                  <Row label="Shipping">{formatCheckoutPrice(detail.shippingCents)}</Row>
                  {detail.taxCents > 0 && (
                    <Row label="Tax">{formatCheckoutPrice(detail.taxCents)}</Row>
                  )}
                  {detail.discountCents > 0 && (
                    <Row label="Discount">−{formatCheckoutPrice(detail.discountCents)}</Row>
                  )}
                  <Row label="Total" bold>{formatCheckoutPrice(detail.totalCents)}</Row>

                  {detail.fulfillmentStatus === 'unfulfilled' && (
                    <>
                      <Divider />
                      <button
                        onClick={markProcessing}
                        disabled={transitioning}
                        className="h-11 w-full rounded-lg bg-[#111111] text-[11px] font-medium tracking-[0.04em] text-white transition hover:bg-black/80 disabled:opacity-50"
                      >
                        {transitioning ? 'Updating…' : 'Mark processing'}
                      </button>
                    </>
                  )}

                  {detail.fulfillmentStatus === 'processing' && (
                    <>
                      <Divider />
                      <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                        Shipment
                      </p>

                      <div className="space-y-2">
                        <select
                          value={carrier}
                          onChange={e => setCarrier(e.target.value)}
                          className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none focus:border-black/25"
                        >
                          <option value="">Carrier *</option>
                          {['USPS','UPS','FedEx','DHL','Other'].map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>

                        <input
                          value={tracking}
                          onChange={e => setTracking(e.target.value)}
                          placeholder="Tracking number *"
                          className="h-10 w-full rounded-lg border border-black/[0.09] bg-[#FAFAF9] px-3 text-[12px] outline-none placeholder:text-black/25 focus:border-black/25"
                        />

                        <button
                          onClick={markShipped}
                          disabled={transitioning}
                          className="h-11 w-full rounded-lg bg-[#111111] text-[11px] font-medium tracking-[0.04em] text-white transition hover:bg-black/80 disabled:opacity-50"
                        >
                          {transitioning ? 'Saving…' : 'Confirm shipment'}
                        </button>
                      </div>
                    </>
                  )}

                  {detail.shipment && (
                    <>
                      <Divider />
                      <p className="mb-3 text-[9px] font-medium uppercase tracking-[0.15em] text-black/30">
                        Tracking
                      </p>
                      <Row label="Carrier">{detail.shipment.carrier ?? '—'}</Row>
                      <Row label="Tracking">{detail.shipment.trackingNumber ?? '—'}</Row>
                      {detail.shipment.shippedAt && (
                        <Row label="Shipped">
                          {new Date(detail.shipment.shippedAt).toLocaleString()}
                        </Row>
                      )}
                    </>
                  )}

                  {txMsg && (
                    <div className={[
                      'mt-4 rounded-lg border px-3 py-2.5 text-[11px]',
                      txMsg.includes('processing')
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-red-200 bg-red-50 text-red-700',
                    ].join(' ')}>
                      {txMsg}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        )}
      </div>
    </div>
  )
}

// ── Layout helpers ─────────────────────────────────────────────────────────────

function Row({ label, children, bold }: { label:string; children:React.ReactNode; bold?:boolean }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start',
                  fontSize:12, padding:'3px 0', gap:8 }}>
      <span style={{ color:'#9B9B9B', flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight: bold?600:400, textAlign:'right' }}>{children}</span>
    </div>
  )
}

function Divider() {
  return <div style={{ borderTop:'1px solid #F1EEE8', margin:'10px 0' }} />
}

const selStyle: React.CSSProperties = {
  padding:'8px 12px', fontSize:13, border:'1px solid #D1CCBF',
  background:'#fff', outline:'none', cursor:'pointer',
}
const thStyle: React.CSSProperties = {
  padding:'8px 10px', textAlign:'left', fontSize:11, fontWeight:600,
  letterSpacing:'0.06em', textTransform:'uppercase', color:'#6b7280',
  whiteSpace:'nowrap',
}
const tdStyle: React.CSSProperties = {
  padding:'10px 10px', verticalAlign:'middle',
}
const btnOutline: React.CSSProperties = {
  padding:'8px 14px', fontSize:12, border:'1px solid #D1CCBF',
  background:'#fff', cursor:'pointer', color:'#1A1A1A',
}
const btnPrimary: React.CSSProperties = {
  padding:'10px 16px', fontSize:13, border:'none',
  background:'#1A1A1A', color:'#fff', cursor:'pointer',
  letterSpacing:'0.04em',
}
