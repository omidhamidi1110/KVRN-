'use client'
import { useEffect, useState, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useCart } from '@/context/CartContext'

type Status = {
  reservationStatus?: string
  orderNumber?:       string | null
  paymentStatus?:     string | null
}

function Content() {
  const params    = useSearchParams()
  const sessionId = params.get('session_id')
  const { clearCart } = useCart()

  const [data,    setData]    = useState<Status | null>(null)
  const [polling, setPolling] = useState(Boolean(sessionId))
  const doneRef    = useRef(false)
  const clearedRef = useRef(false)
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controlRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!sessionId) { setPolling(false); return }
    doneRef.current    = false
    clearedRef.current = false
    let attempts = 0
    const MAX = 15

    const stop = () => {
      doneRef.current = true
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      if (controlRef.current) { controlRef.current.abort(); controlRef.current = null }
      setPolling(false)
    }

    const poll = () => {
      if (doneRef.current) return
      controlRef.current = new AbortController()
      fetch(`/api/checkout/status?session_id=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store', signal: controlRef.current.signal,
      })
        .then(r => r.ok ? r.json() : null)
        .then((d: Status | null) => {
          if (doneRef.current) return
          if (d) {
            setData(d)
            if (d.paymentStatus === 'paid' && !clearedRef.current) {
              clearedRef.current = true
              clearCart()
            }
          }
          attempts++
          const terminal = d?.paymentStatus === 'paid' ||
                           d?.reservationStatus === 'released' ||
                           d?.reservationStatus === 'failed'
          if (terminal || attempts >= MAX) stop()
          else timerRef.current = setTimeout(poll, 2000)
        })
        .catch(err => {
          if (doneRef.current || err?.name === 'AbortError') return
          attempts++
          if (attempts >= MAX) stop()
          else timerRef.current = setTimeout(poll, 2000)
        })
    }

    poll()
    return stop
  }, [sessionId, clearCart])

  if (!sessionId) {
    return (
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 26, marginBottom: 16, fontWeight: 400, color: '#1A1A1A' }}>
          Session not found.
        </h1>
        <p style={{ color: '#6b7280', lineHeight: 1.7, fontSize: 15, maxWidth: 420, margin: '0 auto' }}>
          If you completed a checkout, your session reference may have expired. Contact support with your order details.
        </p>
      </div>
    )
  }

  const isPaid   = data?.paymentStatus === 'paid'
  const isFailed = data?.reservationStatus === 'released' || data?.reservationStatus === 'failed'
  // isTimeout: polling exhausted without terminal state (data may still be null)
  const isTimeout = !polling && !isPaid && !isFailed

  // Shortened session ref for pending/timeout support queries
  const sessionRef = sessionId && !isPaid
    ? sessionId.replace('cs_test_', '').slice(0, 12) + '...'
    : null

  const headline = isPaid   ? 'Payment confirmed.'
                 : isFailed ? 'Payment not confirmed.'
                 : isTimeout ? "We're still confirming your payment."
                 :             'Processing payment.'

  const message  = isPaid
    ? 'Your order has been received.'
    : isFailed
    ? 'Payment was not confirmed. Check your payment method or contact support if you see a charge.'
    : isTimeout
    ? 'We could not confirm your payment in the expected time. Please check back or contact support.'
    : 'Payment verification is in progress. This page updates automatically.'

  return (
    <div style={{ textAlign: 'center' }}>
      <h1 style={{ fontSize: 26, marginBottom: 16, fontWeight: 400, color: '#1A1A1A' }}>
        {headline}
      </h1>
      {data?.orderNumber && (
        <p style={{ fontSize: 13, color: '#9B9B9B', marginBottom: 12 }}>
          {'Order ' + data.orderNumber}
        </p>
      )}
      {!isPaid && sessionRef && (
        <p style={{ fontSize: 11, color: '#C8C4BF', marginBottom: 12, fontFamily: 'monospace' }}>
          {'Ref: ' + sessionRef}
        </p>
      )}
      <p style={{ color: '#6b7280', lineHeight: 1.7, fontSize: 15, maxWidth: 440, margin: '0 auto' }}>
        {message}
      </p>
      {polling && !isPaid && !isFailed && (
        <p style={{ marginTop: 16, fontSize: 12, color: '#C8C4BF' }}>Checking status...</p>
      )}
    </div>
  )
}

export default function CheckoutSuccessPage() {
  return (
    <div data-nav-theme="light"
      style={{ minHeight: '100vh', background: '#F9F8F6', paddingTop: 'calc(36px + 56px + 48px)' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 24px' }}>
        <Suspense fallback={<p style={{ textAlign: 'center', color: '#9B9B9B' }}>Loading...</p>}>
          <Content />
        </Suspense>
      </div>
    </div>
  )
}
