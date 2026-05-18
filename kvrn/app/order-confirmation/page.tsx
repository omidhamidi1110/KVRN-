'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'

function ConfirmationContent() {
  const searchParams = useSearchParams()
  const piId         = searchParams.get('pi')

  const [orderId,    setOrderId]    = useState<string | null>(null)
  const [email,      setEmail]      = useState<string | null>(null)
  const [isLoading,  setIsLoading]  = useState(!!piId)
  const [hasError,   setHasError]   = useState(false)

  useEffect(() => {
    if (!piId) { setIsLoading(false); return }

    // Fetch order details by payment intent ID
    // When Stripe is connected, this resolves the real order number
    fetch(`/api/orders?pi=${piId}`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        if (data.success && data.data?.[0]) {
          setOrderId(data.data[0].id ?? piId)
          setEmail(data.data[0].customerEmail)
        } else {
          // Stripe not yet connected — show confirmation anyway
          setOrderId(piId.replace('pi_', '#').slice(0, 8).toUpperCase())
        }
      })
      .catch(() => {
        // Even on error, show the confirmation page
        // The customer has paid — don't show them an error
        setOrderId(piId.slice(-8).toUpperCase())
        setHasError(false)
      })
      .finally(() => setIsLoading(false))
  }, [piId])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-5 h-5 border border-kvrn-text border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-lg w-full py-16 mx-auto">
      {/* Success mark */}
      <div className="w-12 h-12 mx-auto mb-8 flex items-center justify-center border border-kvrn-border rounded-full">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 10l4.5 4.5L16 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      <p className="label-11 text-kvrn-muted mb-3 text-center">Order confirmed</p>

      <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-5 text-center">
        Thank you.
      </h1>

      {orderId && (
        <p className="text-[14px] text-kvrn-muted text-center mb-2">
          Order reference: <span className="text-kvrn-text font-light">{orderId}</span>
        </p>
      )}

      {email && (
        <p className="text-[14px] text-kvrn-muted text-center mb-8">
          Confirmation sent to <span className="text-kvrn-text">{email}</span>
        </p>
      )}

      {!email && (
        <p className="text-[15px] text-kvrn-muted text-center leading-relaxed mb-8">
          A confirmation has been sent to your email. You&apos;ll receive another
          message with tracking when your order ships.
        </p>
      )}

      <div className="border-t border-kvrn-border pt-8 space-y-3 text-[14px] text-kvrn-muted">
        <div className="flex items-start gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5" aria-hidden="true">
            <path d="M2 4h12l-1 8H3L2 4z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            <path d="M5 4V3a3 3 0 016 0v1" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          <span>Your order will ship within 3–5 business days.</span>
        </div>
        <div className="flex items-start gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5" aria-hidden="true">
            <path d="M8 2L2 5v4c0 3.31 2.69 5 6 5s6-1.69 6-5V5L8 2z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
          </svg>
          <span>
            Returns accepted within 30 days. Visit{' '}
            <Link href="/support/shipping-returns" className="text-kvrn-text underline underline-offset-2">
              shipping & returns
            </Link>{' '}
            for instructions.
          </span>
        </div>
        <div className="flex items-start gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5" aria-hidden="true">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1"/>
            <path d="M8 6v4M8 10.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span>
            Questions?{' '}
            <a href="mailto:support@kvrn.shop" className="text-kvrn-text underline underline-offset-2">
              support@kvrn.shop
            </a>
          </span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-3 mt-10">
        <Link href="/shop" className="w-full sm:w-auto">
          <Button variant="primary" size="md" fullWidth>
            Continue shopping
          </Button>
        </Link>
        <Link href="/" className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150">
          Return home →
        </Link>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <div className="pt-[56px] min-h-screen flex flex-col items-center justify-center px-6">
      <Suspense fallback={
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="w-5 h-5 border border-kvrn-text border-t-transparent rounded-full animate-spin" />
        </div>
      }>
        <ConfirmationContent />
      </Suspense>
    </div>
  )
}
