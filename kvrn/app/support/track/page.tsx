'use client'

import { PageHero } from '@/components/layout/PageHero'
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/context/I18nContext'
import { fillMessages, format, type MessageKey } from '@/lib/i18n/messages'

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

// Known order statuses (the label/description for each lives in the dictionary: track.status.<key>).
const KNOWN_STATUSES = new Set([
  'pending', 'paid', 'unfulfilled', 'processing', 'fulfilled', 'shipped', 'delivered',
  'cancelled', 'return_pending', 'returned', 'refunded',
])


export default function TrackOrderPage() {
  const t = fillMessages(useI18n().t)
  const [orderId,  setOrderId]  = useState('')
  const [email,    setEmail]    = useState('')
  const [state,    setState]    = useState<TrackState>('idle')
  const [result,   setResult]   = useState<OrderResult | null>(null)
  const [inputErr, setInputErr] = useState('')

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setInputErr('')

    if (!orderId.trim() || !email.trim()) {
      setInputErr(t['track.enterBoth'])
      return
    }

    setState('loading')

    try {
      const res = await fetch('/api/order-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: orderId.trim(),
          email: email.trim(),
        }),
      })
      const data = await res.json()

      if (!res.ok || !data.success || !data.data) {
        setState('not-found')
        return
      }

      const order = data.data
      setResult({
        id:               order.orderNumber,
        status:           order.status ?? 'unfulfilled',
        trackingNumber:   order.trackingNumber ?? null,
        carrier:          order.carrier ?? null,
        trackingUrl:      null,
        createdAt:        order.createdAt,
        lineItems:        order.lineItems ?? [],
      })
      setState('found')
    } catch {
      setState('not-found')
    }
  }

  const status = result
    ? (KNOWN_STATUSES.has(result.status)
        ? { label: t[`track.status.${result.status}` as MessageKey], description: t[`track.status.${result.status}.desc` as MessageKey] }
        : { label: result.status, description: '' })
    : null

  return (
    <div>
      <PageHero title={t['track.title']} breadcrumb={t['track.title']} />
      <div data-nav-theme="light" className="container-kvrn section-padding max-w-xl">
<h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-10">
          {t.trackYourOrder}
        </h1>

        {/* Search form */}
        <form onSubmit={handleSearch} className="space-y-4" noValidate>
          <div>
            <label htmlFor="order-id" className="label-11 block mb-2">
              {t['track.orderNumber']}
            </label>
            <input
              id="order-id"
              type="text"
              placeholder="KVRN-001001"
              value={orderId}
              onChange={e => { setOrderId(e.target.value); setInputErr('') }}
              className="kvrn-input"
            />
          </div>

          <div>
            <label htmlFor="track-email" className="label-11 block mb-2">
              {t['track.emailAddress']}
            </label>
            <input
              id="track-email"
              type="email"
              autoComplete="email"
              placeholder={t['track.emailPlaceholder']}
              value={email}
              onChange={e => { setEmail(e.target.value); setInputErr('') }}
              className="kvrn-input"
            />
          </div>

          {inputErr && (
            <p role="alert" className="text-[12px] text-kvrn-error">{inputErr}</p>
          )}

          <Button type="submit" variant="primary" size="md" loading={state === 'loading'}>
            {t['track.find']}
          </Button>
        </form>

        {/* Results */}
        {state === 'not-found' && (
          <div className="mt-10 border border-kvrn-border p-6">
            <p className="text-[14px] font-light mb-2">{t['track.notFoundTitle']}</p>
            <p className="text-[13px] text-kvrn-muted leading-relaxed">
              {t['track.notFoundBody']}{' '}
              <a href="mailto:orders@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                orders@kvrn.shop
              </a>{' '}
              {t['track.notFoundBodyEnd']}
            </p>
          </div>
        )}

        {state === 'found' && result && status && (
          <div className="mt-10 space-y-6">
            <div className="rule" />

            {/* Status */}
            <div>
              <p className="label-11 mb-2">{t['track.status']}</p>
              <p className="text-[18px] font-light">{status.label}</p>
              {status.description && (
                <p className="text-[13px] text-kvrn-muted mt-1">{status.description}</p>
              )}
            </div>

            {/* Tracking */}
            {result.trackingNumber && (
              <div className="border-t border-kvrn-border pt-6">
                <p className="label-11 mb-2">{t['track.tracking']}</p>
                <p className="text-[14px] font-light">{result.carrier} — {result.trackingNumber}</p>
                {result.trackingUrl && (
                  <a
                    href={result.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-3 text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 h-9 flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
                  >
                    {format(t['track.trackWith'], { carrier: result.carrier ?? '' })}
                  </a>
                )}
              </div>
            )}

            {/* Items */}
            {result.lineItems.length > 0 && (
              <div className="border-t border-kvrn-border pt-6">
                <p className="label-11 mb-4">{t['track.items']}</p>
                <ul className="space-y-2">
                  {result.lineItems.map((item, i) => (
                    <li key={i} className="text-[14px] font-light">
                      {item.name}
                      <span className="text-kvrn-muted ms-2 font-light">
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
                {t['track.questions']}{' '}
                <a href="mailto:orders@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
                  orders@kvrn.shop
                </a>
              </p>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
