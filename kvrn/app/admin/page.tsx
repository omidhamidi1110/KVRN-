// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD — MVP
// Password protection: Add middleware for production.
// For launch: protect with HTTP Basic Auth via Cloudflare Access (free).
// Full admin spec: V4 Blueprint Section 8.
// ─────────────────────────────────────────────────────────────────────────────

import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title:  'Admin — KVRN',
  robots: { index: false, follow: false },
}

// Placeholder data — replace with Neon DB queries
const stats = {
  revenue:     23800,
  orders:      12,
  unfulfilled: 3,
  returns:     1,
}

const orders = [
  { id: '#1012', date: '17 May', customer: 'James T.', total: 42000, status: 'unfulfilled', items: 'Hoodie / Stone / L' },
  { id: '#1011', date: '17 May', customer: 'Sarah M.', total: 23000, status: 'unfulfilled', items: 'Hoodie / Slate / M' },
  { id: '#1010', date: '16 May', customer: 'Mark R.',  total: 42000, status: 'unfulfilled', items: 'Sweatpants / Stone / S' },
  { id: '#1009', date: '15 May', customer: 'Anna K.',  total: 19000, status: 'fulfilled',   items: 'Sweatpants / Washed Black / M' },
  { id: '#1008', date: '14 May', customer: 'Tom L.',   total: 42000, status: 'fulfilled',   items: 'Hoodie / Off White / L' },
]

const inventory = [
  { product: 'Hoodie',     color: 'Stone',        size: 'XS', stock: 12 },
  { product: 'Hoodie',     color: 'Stone',        size: 'S',  stock: 8  },
  { product: 'Hoodie',     color: 'Stone',        size: 'M',  stock: 3  },
  { product: 'Hoodie',     color: 'Stone',        size: 'L',  stock: 0  },
  { product: 'Hoodie',     color: 'Stone',        size: 'XL', stock: 15 },
  { product: 'Sweatpants', color: 'Stone',        size: 'M',  stock: 7  },
  { product: 'Sweatpants', color: 'Slate',        size: 'L',  stock: 2  },
]

const formatPrice = (p: number) => `£${(p / 100).toFixed(0)}`

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-kvrn-bg pt-[56px]">
      <div className="container-kvrn py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="label-11 mb-1">KVRN Admin</p>
            <h1 className="font-display font-light text-[32px] leading-none tracking-tighter">
              Dashboard
            </h1>
          </div>
          <Link href="/" className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
            ← View site
          </Link>
        </div>

        {/* Notice */}
        <div className="border border-kvrn-border bg-kvrn-bg-raised px-4 py-3 mb-8 text-[13px] text-kvrn-muted">
          MVP admin dashboard — showing placeholder data. Connect Neon DB to display live orders.
          Add Cloudflare Access for authentication before going live.
        </div>

        {/* ─── Stats ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: 'Revenue (month)',  value: formatPrice(stats.revenue) },
            { label: 'Total orders',     value: stats.orders.toString() },
            { label: 'Unfulfilled',      value: stats.unfulfilled.toString(), alert: stats.unfulfilled > 0 },
            { label: 'Returns pending',  value: stats.returns.toString(),    alert: stats.returns > 0 },
          ].map((stat) => (
            <div
              key={stat.label}
              className={`border p-4 ${stat.alert ? 'border-kvrn-error/50 bg-kvrn-error/5' : 'border-kvrn-border'}`}
            >
              <p className="label-11 text-kvrn-muted mb-2">{stat.label}</p>
              <p className={`text-[28px] font-display font-light ${stat.alert ? 'text-kvrn-error' : ''}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* ─── Orders ─── */}
        <section className="mb-10" aria-labelledby="orders-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="orders-heading" className="label-11">Orders</h2>
            <div className="flex gap-3 text-[11px] text-kvrn-muted tracking-wide">
              <button className="hover:text-kvrn-text transition-colors">All</button>
              <button className="text-kvrn-text underline underline-offset-2">Unfulfilled</button>
              <button className="hover:text-kvrn-text transition-colors">Fulfilled</button>
            </div>
          </div>

          <div className="border border-kvrn-border overflow-hidden">
            <div className="hidden md:grid grid-cols-[80px_1fr_1fr_100px_120px_120px] gap-4 px-4 py-3 border-b border-kvrn-border bg-kvrn-bg-raised">
              {['Order', 'Date', 'Customer', 'Total', 'Items', 'Status'].map((h) => (
                <span key={h} className="label-11 text-kvrn-muted">{h}</span>
              ))}
            </div>

            {orders.map((order) => (
              <div
                key={order.id}
                className="grid grid-cols-1 md:grid-cols-[80px_1fr_1fr_100px_120px_120px] gap-2 md:gap-4 px-4 py-4 border-b border-kvrn-border last:border-0 text-[13px] items-center"
              >
                <span className="font-light">{order.id}</span>
                <span className="text-kvrn-muted">{order.date}</span>
                <span className="font-light">{order.customer}</span>
                <span className="font-light">{formatPrice(order.total)}</span>
                <span className="text-kvrn-muted text-[12px]">{order.items}</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block px-2 py-0.5 text-[10px] tracking-wide uppercase ${
                      order.status === 'unfulfilled'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-green-50 text-green-700 border border-green-200'
                    }`}
                  >
                    {order.status}
                  </span>
                  {order.status === 'unfulfilled' && (
                    <button className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
                      Fulfill →
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Inventory ─── */}
        <section aria-labelledby="inventory-heading">
          <h2 id="inventory-heading" className="label-11 mb-4">Inventory</h2>
          <div className="border border-kvrn-border overflow-hidden">
            <div className="hidden md:grid grid-cols-[1fr_120px_80px_100px_120px] gap-4 px-4 py-3 border-b border-kvrn-border bg-kvrn-bg-raised">
              {['Product', 'Color', 'Size', 'Stock', 'Status'].map((h) => (
                <span key={h} className="label-11 text-kvrn-muted">{h}</span>
              ))}
            </div>
            {inventory.map((item, i) => (
              <div
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_120px_80px_100px_120px] gap-2 md:gap-4 px-4 py-3.5 border-b border-kvrn-border last:border-0 text-[13px] items-center"
              >
                <span className="font-light">{item.product}</span>
                <span className="text-kvrn-muted">{item.color}</span>
                <span className="text-kvrn-muted">{item.size}</span>
                <span className={`font-light ${item.stock === 0 ? 'text-kvrn-error' : item.stock <= 3 ? 'text-amber-600' : ''}`}>
                  {item.stock}
                </span>
                <span className={`text-[11px] tracking-wide uppercase ${
                  item.stock === 0 ? 'text-kvrn-error' : item.stock <= 3 ? 'text-amber-600' : 'text-kvrn-muted'
                }`}>
                  {item.stock === 0 ? 'Sold out' : item.stock <= 3 ? 'Low' : 'In stock'}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
