'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type TrackState = 'idle' | 'loading' | 'found' | 'not-found'

interface OrderResult {
  id:             string
  status:         string
  trackingNumber: string | null
  carrier:        string | null
  trackingUrl:    string | null
  createdAt:      string
  estimatedDelivery?: string
  lineItems:      Array<{ name: string; color: string; size: string }>
}

const STATUS_LABELS: Record<string, { label: string; description: string }> = {
  pending:        { label: 'Order received',     description: 'Payment confirmed. Preparing for dispatch.' },
  paid:           { label: 'Order confirmed',    description: 'Payment confirmed. Preparing for dispatch.' },
  unfulfilled:    { label: 'Preparing',          description: 'Your order is being prepared.' },
  fulfilled:      { label: 'Ready to ship',      description: 'Packed and ready for collection by the carrier.' },
  shipped:        { label: 'Shipped',            description: 'On its way to you.' },
  delivered:      { label: 'Delivered',          description: 'Your order has been delivered.' },
  cancelled:      { label: 'Cancelled',          description: 'This order has been cancelled.' },
  return_pending: { label: 'Return pending',     description: 'Return in progress.' },
  returned:       { label: 'Returned',           description: 'Return received.' },
  refunded:       { label: 'Refunded',           description: 'Refund has been issued.' },
}

export default function TrackOrderPage() {
  const [orderId,  setOrderId]  = useState('')
  const [email,    setEmail]    = useState('')
  const [state,    setState]    = useState<TrackState>('idle')
  const [result,   setResult]   = useState<OrderResult | null>(null)
  const [inputErr, setInputErr] = useState('')

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setInputErr('')

    if (!orderId.trim() && !email.trim()) {
      setInputErr('Enter your order number or email address.')
      return
    }

    setState('loading')

    try {
      const params = new URLSearchParams()
      if (orderId.trim()) params.set('id',    orderId.trim().replace('#', ''))
      if (email.trim())   params.set('email', email.trim())

      const res  = await fetch(`/api/orders?${params}`)
      const data = await res.json()

      if (!data.success || !data.data?.length) {
        setState('not-found')
        return
      }

      const order = data.data[0]
      setResult({
        id:               order.id,
        status:           order.status ?? 'pending',
        trackingNumber:   order.trackingNumber ?? null,
        carrier:          order.carrier ?? null,
        trackingUrl:      order.trackingNumber
          ? `https://track.royalmail.com/tracking/your-item#${order.trackingNumber}`
          : null,
        createdAt:        order.createdAt,
        lineItems:        order.lineItems ?? [],
      })
      setState('found')
    } catch {
      setState('not-found')
    }
  }

  const status = result ? (STATUS_LABELS[result.status] ?? { label: result.status, description: '' }) : null

  return (
    <div className="pt-[calc(36px+56px)]">
      <div className="container-kvrn section-padding max-w-xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li><Link href="/support/faq" className="hover:text-kvrn-text transition-colors">Support</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Track order</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-10">
          Track your order
        </h1>

        {/* Search form */}
        <form onSubmit={handleSearch} className="space-y-4" noValidate>
          <div>
            <label htmlFor="order-id" className="label-11 block mb-2">
              Order number <span className="text-kvrn-subtle normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="order-id"
              type="text"
              placeholder="#1042"
              value={orderId}
              onChange={e => { setOrderId(e.target.value); setInputErr('') }}
              className="kvrn-input"
            />
          </div>

          <div>
            <label htmlFor="track-email" className="label-11 block mb-2">
              Email address <span className="text-kvrn-subtle normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="track-email"
              type="email"
              autoComplete="email"
              placeholder="Email used at checkout"
              value={email}
              onChange={e => { setEmail(e.target.value); setInputErr('') }}
              className="kvrn-input"
            />
          </div>

          {inputErr && (
            <p role="alert" className="text-[12px] text-kvrn-error">{inputErr}</p>
          )}

          <Button type="submit" variant="primary" size="md" loading={state === 'loading'}>
            Find my order
          </Button>
        </form>

        {/* Results */}
        {state === 'not-found' && (
          <div className="mt-10 border border-kvrn-border p-6">
            <p className="text-[14px] font-light mb-2">Order not found.</p>
            <p className="text-[13px] text-kvrn-muted leading-relaxed">
              Check your order number and email match what you entered at checkout.
              If you&apos;re still having trouble, email{' '}
              <a href="mailto:orders@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                orders@kvrn.shop
              </a>{' '}
              with your order details.
            </p>
          </div>
        )}

        {state === 'found' && result && status && (
          <div className="mt-10 space-y-6">
            <div className="rule" />

            {/* Status */}
            <div>
              <p className="label-11 mb-2">Status</p>
              <p className="text-[18px] font-light">{status.label}</p>
              {status.description && (
                <p className="text-[13px] text-kvrn-muted mt-1">{status.description}</p>
              )}
            </div>

            {/* Tracking */}
            {result.trackingNumber && (
              <div className="border-t border-kvrn-border pt-6">
                <p className="label-11 mb-2">Tracking</p>
                <p className="text-[14px] font-light">{result.carrier} — {result.trackingNumber}</p>
                {result.trackingUrl && (
                  <a
                    href={result.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-3 text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 h-9 flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
                  >
                    Track with {result.carrier} →
                  </a>
                )}
              </div>
            )}

            {/* Items */}
            {result.lineItems.length > 0 && (
              <div className="border-t border-kvrn-border pt-6">
                <p className="label-11 mb-4">Items</p>
                <ul className="space-y-2">
                  {result.lineItems.map((item, i) => (
                    <li key={i} className="text-[14px] font-light">
                      {item.name}
                      <span className="text-kvrn-muted ml-2 font-light">
                        {item.color} / {item.size}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Help */}
            <div className="border-t border-kvrn-border pt-6">
              <p className="text-[13px] text-kvrn-muted">
                Questions about your order?{' '}
                <a href="mailto:orders@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                  orders@kvrn.shop
                </a>
              </p>
            </div>
          </div>
        )}

        {/* Dev notice */}
        <div className="mt-12 border border-kvrn-border bg-kvrn-bg-raised p-4 text-[12px] text-kvrn-muted leading-relaxed">
          <strong className="font-light text-kvrn-text">Dev note:</strong> Order lookup requires Neon DB connected.
          Connect <code className="bg-kvrn-bg px-1">DATABASE_URL</code> and uncomment the DB queries
          in <code className="bg-kvrn-bg px-1">/api/orders/route.ts</code>.
        </div>
      </div>
    </div>
  )
}
