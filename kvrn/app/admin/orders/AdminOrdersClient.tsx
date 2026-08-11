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
    <div style={{ minHeight:'100vh', background:'#F9F8F6', paddingTop:'calc(36px + 56px)' }}>
      <div style={{ maxWidth:1400, margin:'0 auto', padding:'32px 24px' }}>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <h1 style={{ fontSize:20, fontWeight:500, color:'#1A1A1A', letterSpacing:'0.04em', textTransform:'uppercase' }}>
            Orders
          </h1>
          <span style={{ fontSize:12, color:'#9B9B9B' }}>
            {meta.total} total
          </span>
        </div>

        {/* Filters */}
        <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:20 }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key==='Enter' && fetchOrders(0)}
            placeholder="Order #, customer name, or email"
            style={{ flex:'1 1 260px', padding:'8px 12px', fontSize:13, border:'1px solid #D1CCBF', background:'#fff', outline:'none' }}
          />
          <select value={payFilter} onChange={e => setPayFilter(e.target.value)}
            style={selStyle}>
            <option value="">All payment statuses</option>
            {['pending','paid','failed','refunded'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fulFilter} onChange={e => setFulFilter(e.target.value)}
            style={selStyle}>
            <option value="">All fulfillment statuses</option>
            {['unfulfilled','processing','shipped','delivered','cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={() => fetchOrders(0)} style={btnOutline}>Search</button>
          <button onClick={() => { setSearch(''); setPayFilter(''); setFulFilter(''); }} style={btnOutline}>Clear</button>
        </div>

        {error && (
          <div style={{ padding:'10px 14px', background:'#FEF2F2', border:'1px solid #FECACA', color:'#B91C1C', fontSize:13, marginBottom:16 }}>
            {error}
          </div>
        )}

        <div style={{ display:'flex', gap:24, alignItems:'flex-start', flexWrap:'wrap' }}>

          {/* Orders table */}
          <div style={{ flex:'1 1 600px', minWidth:0, overflowX:'auto' }}>
            {loading ? (
              <p style={{ color:'#9B9B9B', fontSize:13 }}>Loading...</p>
            ) : orders.length === 0 ? (
              <p style={{ color:'#9B9B9B', fontSize:13 }}>No orders found.</p>
            ) : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:'2px solid #E8E5E0' }}>
                    {['Order','Date','Customer','Items','Total','Payment','Fulfillment','Shipping',''].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id}
                      onClick={() => openDetail(o.id)}
                      style={{ borderBottom:'1px solid #F1EEE8', cursor:'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background='#F9F8F6')}
                      onMouseLeave={e => (e.currentTarget.style.background='')}>
                      <td style={tdStyle}><code style={{ fontSize:11 }}>{o.orderNumber}</code></td>
                      <td style={tdStyle}>{new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}</td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight:500 }}>{o.customerName ?? '—'}</div>
                        <div style={{ color:'#9B9B9B', fontSize:11 }}>{o.customerEmail ?? ''}</div>
                      </td>
                      <td style={{ ...tdStyle, textAlign:'center' }}>{o.quantityCount}</td>
                      <td style={tdStyle}>{formatCheckoutPrice(o.totalCents)}</td>
                      <td style={tdStyle}><Badge text={o.paymentStatus} colour={PAYMENT_COLOURS[o.paymentStatus] ?? '#6B7280'} /></td>
                      <td style={tdStyle}><Badge text={o.fulfillmentStatus} colour={FULFILL_COLOURS[o.fulfillmentStatus] ?? '#6B7280'} /></td>
                      <td style={tdStyle}>{o.shippingMethod ?? '—'}</td>
                      <td style={tdStyle}>
                        <span style={{ fontSize:11, color:'#2563EB', textDecoration:'underline' }}>View</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Pagination */}
            {meta.total > LIMIT && (
              <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:16 }}>
                <button onClick={() => fetchOrders(Math.max(0, offset-LIMIT))}
                  disabled={offset===0} style={btnOutline}>← Prev</button>
                <span style={{ fontSize:12, color:'#6b7280' }}>
                  Page {currentPage} of {totalPages} ({meta.total} orders)
                </span>
                <button onClick={() => fetchOrders(offset+LIMIT)}
                  disabled={offset+LIMIT>=meta.total} style={btnOutline}>Next →</button>
              </div>
            )}
          </div>

          {/* Detail panel */}
          {(detailLoading || detail) && (
            <div style={{ flex:'0 1 380px', minWidth:280, background:'#fff', border:'1px solid #E8E5E0', padding:'20px' }}>
              {detailLoading ? (
                <p style={{ color:'#9B9B9B', fontSize:13 }}>Loading order...</p>
              ) : detail ? (
                <>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
                    <h2 style={{ fontSize:14, fontWeight:600, color:'#1A1A1A' }}>{detail.orderNumber}</h2>
                    <button onClick={() => { setDetail(null); setTxMsg('') }}
                      style={{ background:'none', border:'none', cursor:'pointer', fontSize:16, color:'#9B9B9B' }}>✕</button>
                  </div>

                  <Row label="Payment"><Badge text={detail.paymentStatus} colour={PAYMENT_COLOURS[detail.paymentStatus] ?? '#6B7280'} /></Row>
                  <Row label="Fulfillment"><Badge text={detail.fulfillmentStatus} colour={FULFILL_COLOURS[detail.fulfillmentStatus] ?? '#6B7280'} /></Row>
                  {detail.paidAt && <Row label="Paid">{new Date(detail.paidAt).toLocaleString()}</Row>}
                  <Row label="Created">{new Date(detail.createdAt).toLocaleString()}</Row>

                  <Divider />
                  <Row label="Customer">{detail.customerName ?? '—'}</Row>
                  <Row label="Email">{detail.customerEmail ?? '—'}</Row>
                  {detail.customerPhone && <Row label="Phone">{detail.customerPhone}</Row>}
                  <Row label="Address">{formatAddr(detail.shippingAddress)}</Row>
                  {detail.shippingMethod && <Row label="Shipping">{detail.shippingMethod}</Row>}

                  <Divider />
                  {detail.items.map(item => (
                    <div key={item.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, padding:'4px 0', color:'#1A1A1A' }}>
                      <span style={{ flex:1 }}>
                        {item.productName} — {item.color} / {item.size}
                        {item.quantity > 1 && ` × ${item.quantity}`}
                      </span>
                      <span style={{ flexShrink:0, marginLeft:8 }}>{formatCheckoutPrice(item.lineTotalCents)}</span>
                    </div>
                  ))}

                  <Divider />
                  <Row label="Subtotal">{formatCheckoutPrice(detail.subtotalCents)}</Row>
                  <Row label="Shipping">{formatCheckoutPrice(detail.shippingCents)}</Row>
                  {detail.taxCents > 0 && <Row label="Tax">{formatCheckoutPrice(detail.taxCents)}</Row>}
                  {detail.discountCents > 0 && <Row label="Discount">−{formatCheckoutPrice(detail.discountCents)}</Row>}
                  <Row label="Total" bold>{formatCheckoutPrice(detail.totalCents)}</Row>

                  {detail.fulfillmentStatus === 'unfulfilled' && (
                    <>
                      <Divider />
                      <button onClick={markProcessing} disabled={transitioning}
                        style={{ ...btnPrimary, width:'100%', marginTop:4 }}>
                        {transitioning ? 'Updating...' : 'Mark processing'}
                      </button>
                    </>
                  )}

                  {detail.fulfillmentStatus === 'processing' && (
                    <>
                      <Divider />
                      <p style={{ fontSize:11, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'#1A1A1A', marginBottom:8 }}>Mark shipped</p>
                      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                        <select value={carrier} onChange={e => setCarrier(e.target.value)}
                          style={{ ...selStyle, fontSize:12 }}>
                          <option value="">Carrier *</option>
                          {['USPS','UPS','FedEx','DHL','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input value={tracking} onChange={e => setTracking(e.target.value)}
                          placeholder="Tracking number *"
                          style={{ padding:'8px 10px', fontSize:12, border:'1px solid #D1CCBF', background:'#fff', outline:'none' }}
                        />
                        <button onClick={markShipped} disabled={transitioning}
                          style={{ ...btnPrimary, width:'100%' }}>
                          {transitioning ? 'Saving...' : 'Confirm shipment'}
                        </button>
                      </div>
                    </>
                  )}

                  {detail.shipment && (
                    <>
                      <Divider />
                      <Row label="Carrier">{detail.shipment.carrier ?? '—'}</Row>
                      <Row label="Tracking">{detail.shipment.trackingNumber ?? '—'}</Row>
                      {detail.shipment.shippedAt && (
                        <Row label="Shipped">{new Date(detail.shipment.shippedAt).toLocaleString()}</Row>
                      )}
                    </>
                  )}

                  {txMsg && (
                    <p style={{ marginTop:10, fontSize:12,
                      color: txMsg.includes('processing') ? '#059669' : '#B91C1C' }}>
                      {txMsg}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
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
