'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatCheckoutPrice } from '@/lib/format-money'

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

function statusClass(status: string) {
  if (status === 'paid' || status === 'shipped' || status === 'delivered') {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
  if (status === 'unfulfilled' || status === 'pending') {
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }
  if (status === 'processing') {
    return 'bg-blue-50 text-blue-700 border-blue-200'
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'bg-red-50 text-red-700 border-red-200'
  }
  return 'bg-neutral-50 text-neutral-600 border-neutral-200'
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

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

  if (loading) {
    return (
      <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
        <div className="animate-pulse">
          <div className="h-8 w-44 rounded bg-black/10" />
          <div className="mt-3 h-4 w-72 rounded bg-black/[0.06]" />
          <div className="mt-9 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[0,1,2,3].map(i => (
              <div key={i} className="h-32 rounded-xl bg-white border border-black/[0.06]" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">

      {/* Page header */}
      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">
            KVRN Administration
          </p>
          <h1 className="text-[30px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[34px]">
            Overview
          </h1>
          <p className="mt-2 max-w-xl text-[13px] leading-5 text-black/45">
            Production commerce, fulfillment, and inventory at a glance.
          </p>
        </div>

        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-lg border border-black/[0.10] bg-white px-4 text-[12px] font-medium text-black/65 shadow-sm transition hover:border-black/20 hover:text-black disabled:opacity-50 sm:self-auto"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            className={refreshing ? 'animate-spin' : ''}
            aria-hidden="true"
          >
            <path
              d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-[12px] text-red-700">{error}</p>
          <button
            onClick={() => load()}
            className="text-[11px] font-medium text-red-700 underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      )}

      {data && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div className="rounded-xl border border-black/[0.07] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-6">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-black/35">
                Revenue this month
              </p>
              <p className="mt-5 text-[28px] font-medium tracking-[-0.04em] text-[#171717] sm:text-[32px]">
                {formatCheckoutPrice(data.stats.revenueCents)}
              </p>
              <p className="mt-1 text-[11px] text-black/30">Paid orders</p>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-6">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-black/35">
                Total orders
              </p>
              <p className="mt-5 text-[28px] font-medium tracking-[-0.04em] text-[#171717] sm:text-[32px]">
                {data.stats.totalOrders}
              </p>
              <Link
                href="/admin/orders"
                className="mt-1 inline-flex text-[11px] text-black/30 transition hover:text-black"
              >
                Open orders →
              </Link>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-6">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-black/35">
                Unfulfilled
              </p>
              <p className={[
                'mt-5 text-[28px] font-medium tracking-[-0.04em] sm:text-[32px]',
                data.stats.unfulfilledOrders > 0 ? 'text-amber-600' : 'text-[#171717]',
              ].join(' ')}>
                {data.stats.unfulfilledOrders}
              </p>
              <p className="mt-1 text-[11px] text-black/30">Awaiting processing</p>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] sm:p-6">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-black/35">
                Available units
              </p>
              <p className="mt-5 text-[28px] font-medium tracking-[-0.04em] text-[#171717] sm:text-[32px]">
                {data.stats.availableUnits}
              </p>
              <p className="mt-1 text-[11px] text-black/30">
                {data.stats.soldOutVariants} sold-out variant{data.stats.soldOutVariants === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {/* Quick access */}
          <section className="mt-8">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-black/30">
                  Workspace
                </p>
                <h2 className="mt-1 text-[18px] font-medium tracking-[-0.02em]">
                  Quick access
                </h2>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Link
                href="/admin/orders"
                className="group rounded-xl border border-black/[0.07] bg-white p-5 transition hover:-translate-y-px hover:border-black/[0.14] hover:shadow-sm sm:p-6"
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#111111] text-white">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 3h12l2 4v14H4V7l2-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                      <path d="M4 7h16M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <span className="text-black/25 transition group-hover:text-black">↗</span>
                </div>
                <h3 className="mt-6 text-[16px] font-medium">Orders</h3>
                <p className="mt-1.5 text-[12px] leading-5 text-black/40">
                  Search orders, inspect customer details, process fulfillment, and add shipment tracking.
                </p>
              </Link>

              <Link
                href="/admin/inventory"
                className="group rounded-xl border border-black/[0.07] bg-white p-5 transition hover:-translate-y-px hover:border-black/[0.14] hover:shadow-sm sm:p-6"
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#111111] text-white">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                      <path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  </div>
                  <span className="text-black/25 transition group-hover:text-black">↗</span>
                </div>
                <h3 className="mt-6 text-[16px] font-medium">Inventory</h3>
                <p className="mt-1.5 text-[12px] leading-5 text-black/40">
                  Manage stock, reservations, variant availability, and review inventory movements.
                </p>
              </Link>
            </div>
          </section>

          <div className="mt-8 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">

            {/* Recent orders */}
            <section className="overflow-hidden rounded-xl border border-black/[0.07] bg-white">
              <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4 sm:px-6">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-black/30">
                    Commerce
                  </p>
                  <h2 className="mt-1 text-[16px] font-medium">Recent orders</h2>
                </div>
                <Link
                  href="/admin/orders"
                  className="text-[11px] font-medium text-black/35 transition hover:text-black"
                >
                  View all →
                </Link>
              </div>

              {data.recentOrders.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <p className="text-[13px] text-black/35">No orders yet.</p>
                </div>
              ) : (
                <div>
                  {data.recentOrders.map(order => (
                    <Link
                      key={order.id}
                      href="/admin/orders"
                      className="grid grid-cols-[1fr_auto] gap-4 border-b border-black/[0.05] px-5 py-4 transition last:border-0 hover:bg-black/[0.015] sm:px-6"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium">{order.orderNumber}</span>
                          <span className={[
                            'rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em]',
                            statusClass(order.fulfillmentStatus),
                          ].join(' ')}>
                            {order.fulfillmentStatus}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-black/35">
                          {order.customerName || order.customerEmail || 'Customer'}
                          {' · '}
                          {dateLabel(order.createdAt)}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-[13px] font-medium">
                          {formatCheckoutPrice(order.totalCents)}
                        </p>
                        <p className="mt-1 text-[10px] text-black/30">
                          {order.quantityCount} item{order.quantityCount === 1 ? '' : 's'}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {/* Inventory attention */}
            <section className="overflow-hidden rounded-xl border border-black/[0.07] bg-white">
              <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-black/30">
                    Inventory
                  </p>
                  <h2 className="mt-1 text-[16px] font-medium">Needs attention</h2>
                </div>
                <Link
                  href="/admin/inventory"
                  className="text-[11px] font-medium text-black/35 transition hover:text-black"
                >
                  Manage →
                </Link>
              </div>

              {soldOut.length === 0 ? (
                <div className="px-5 py-10">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                    ✓
                  </div>
                  <p className="mt-4 text-[13px] font-medium">Inventory looks healthy</p>
                  <p className="mt-1 text-[11px] leading-5 text-black/35">
                    No active variants are currently sold out.
                  </p>
                </div>
              ) : (
                <div>
                  {soldOut.map(v => (
                    <Link
                      href="/admin/inventory"
                      key={v.id}
                      className="flex items-center justify-between gap-4 border-b border-black/[0.05] px-5 py-4 transition last:border-0 hover:bg-black/[0.015]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-medium">{v.product_name}</p>
                        <p className="mt-1 truncate text-[10px] text-black/35">
                          {v.size} · {v.sku}
                        </p>
                      </div>
                      <span className="flex-shrink-0 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.06em] text-red-700">
                        Sold out
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
