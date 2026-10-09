'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatCheckoutPrice } from '@/lib/format-money'
import { statusForRaw } from '@/lib/admin-status'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminButton, AdminStat, AdminStatGrid,
  AdminEmpty, AdminError, AdminLoading, StatusBadge, AdminTag,
} from '@/components/admin/ui/AdminUI'

type Order = {
  id: string
  orderNumber: string
  paymentStatus: string
  fulfillmentStatus: string
  totalCents: number
  customerName: string | null
  customerEmail: string | null
  createdAt: string
  quantityCount: number
}

type Variant = {
  id: string
  sku: string
  size: string
  product_name: string
  stock_on_hand: number
  reserved_quantity: number
  available_quantity: number
  active: boolean
}

type DashboardData = {
  stats: {
    revenueCents: number
    totalOrders: number
    unfulfilledOrders: number
    availableUnits: number
    soldOutVariants: number
  }
  recentOrders: Order[]
  inventory: Variant[]
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

const QUICK_LINKS = [
  {
    href: '/admin/orders', title: 'Orders', text: 'Search, fulfill, and track.',
    icon: (
      <>
        <path d="M6 3h12l2 4v14H4V7l2-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M4 7h16M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </>
    ),
  },
  {
    href: '/admin/inventory', title: 'Inventory', text: 'Stock and availability.',
    icon: (
      <>
        <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" stroke="currentColor" strokeWidth="1.5"/>
      </>
    ),
  },
]

const cardLink = 'text-[11px] font-medium text-[#6B6B66] transition hover:text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40 rounded'

export function AdminDashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/admin/dashboard', { cache: 'no-store' })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Unable to load dashboard.')
        return
      }

      setData(json)
    } catch {
      setError('Unable to connect to the dashboard service.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const soldOut = useMemo(() => {
    if (!data) return []
    return data.inventory
      .filter(v => v.active && Number(v.available_quantity) <= 0)
      .slice(0, 6)
  }, [data])

  return (
    <AdminPage width="wide">
      <AdminPageHeader
        title="Overview"
        description="Orders, fulfillment, and stock."
        actions={
          <AdminButton onClick={() => load(true)} disabled={refreshing || loading}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </AdminButton>
        }
      />

      {loading && !data && <AdminLoading />}

      {error && (
        <div className="mb-5">
          <AdminError message={error} onRetry={() => load()} />
        </div>
      )}

      {data && (
        <>
          <AdminStatGrid min={200}>
            <AdminStat label="Revenue this month" value={formatCheckoutPrice(data.stats.revenueCents)} sub="Paid orders" />
            <AdminStat
              label="Total orders"
              value={data.stats.totalOrders}
              sub={<Link href="/admin/orders" className="hover:text-[#171717] hover:underline">Open orders →</Link>}
            />
            <AdminStat
              label="Unfulfilled"
              value={data.stats.unfulfilledOrders}
              tone={data.stats.unfulfilledOrders > 0 ? 'warning' : 'default'}
              sub="Awaiting processing"
            />
            <AdminStat
              label="Available units"
              value={data.stats.availableUnits}
              sub={`${data.stats.soldOutVariants} sold-out variant${data.stats.soldOutVariants === 1 ? '' : 's'}`}
            />
          </AdminStatGrid>

          {/* Quick access */}
          <section className="mt-8">
            <AdminSectionHeader title="Quick access" />
            <div className="grid gap-3 sm:grid-cols-2">
              {QUICK_LINKS.map(l => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="group flex items-center gap-4 rounded-[14px] border border-black/[0.08] bg-white p-4 transition hover:border-black/[0.18] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40"
                >
                  <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-[#111111] text-white">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">{l.icon}</svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-[#171717]">{l.title}</span>
                    <span className="block text-[12px] text-[#6B6B66]">{l.text}</span>
                  </span>
                  <span aria-hidden="true" className="text-[#8A8A85] transition group-hover:text-[#171717]">↗</span>
                </Link>
              ))}
            </div>
          </section>

          <div className="mt-8 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
            {/* Recent orders */}
            <AdminCard padded={false} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3 sm:px-5">
                <h2 className="text-[13px] font-medium">Recent orders</h2>
                <Link href="/admin/orders" className={cardLink}>View all →</Link>
              </div>

              {data.recentOrders.length === 0 ? (
                <div className="p-4"><AdminEmpty title="No orders yet." /></div>
              ) : (
                <div>
                  {data.recentOrders.map(order => {
                    const st = statusForRaw(order.fulfillmentStatus)
                    return (
                      <Link
                        key={order.id}
                        href="/admin/orders"
                        className="grid grid-cols-[1fr_auto] gap-4 border-b border-black/[0.05] px-4 py-3 transition last:border-0 hover:bg-black/[0.015] focus:outline-none focus-visible:bg-black/[0.03] sm:px-5"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium">{order.orderNumber}</span>
                            {st
                              ? <StatusBadge status={st} />
                              : <AdminTag>{order.fulfillmentStatus}</AdminTag>}
                          </div>
                          <p className="mt-1 truncate text-[11px] text-[#6B6B66]">
                            {order.customerName || order.customerEmail || 'Customer'}
                            {' · '}
                            {dateLabel(order.createdAt)}
                          </p>
                        </div>

                        <div className="text-right">
                          <p className="text-[13px] font-medium">{formatCheckoutPrice(order.totalCents)}</p>
                          <p className="mt-1 text-[11px] text-[#8A8A85]">
                            {order.quantityCount} item{order.quantityCount === 1 ? '' : 's'}
                          </p>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </AdminCard>

            {/* Inventory attention */}
            <AdminCard padded={false} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3 sm:px-5">
                <h2 className="text-[13px] font-medium">Needs attention</h2>
                <Link href="/admin/inventory" className={cardLink}>Manage →</Link>
              </div>

              {soldOut.length === 0 ? (
                <div className="p-4"><AdminEmpty title="Nothing needs attention." /></div>
              ) : (
                <div>
                  {soldOut.map(v => (
                    <Link
                      href="/admin/inventory"
                      key={v.id}
                      className="flex items-center justify-between gap-4 border-b border-black/[0.05] px-4 py-3 transition last:border-0 hover:bg-black/[0.015] focus:outline-none focus-visible:bg-black/[0.03] sm:px-5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-medium">{v.product_name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-[#6B6B66]">
                          {v.size} · {v.sku}
                        </p>
                      </div>
                      <AdminTag tone="danger">Sold out</AdminTag>
                    </Link>
                  ))}
                </div>
              )}
            </AdminCard>
          </div>
        </>
      )}
    </AdminPage>
  )
}
