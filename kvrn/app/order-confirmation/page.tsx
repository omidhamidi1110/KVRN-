import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Order Confirmed — KVRN',
  robots: { index: false, follow: false },
}

export default function OrderConfirmationPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center pt-[56px]">
      <div className="max-w-lg w-full py-16">
        <svg
          className="w-12 h-12 mx-auto mb-8 text-kvrn-success"
          viewBox="0 0 48 48"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="24" cy="24" r="23" stroke="currentColor" strokeWidth="1"/>
          <path d="M14 24l8 8 12-16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>

        <p className="label-11 text-kvrn-muted mb-3">Order confirmed</p>
        <h1 className="font-display font-light text-[40px] md:text-[48px] leading-none tracking-tighter mb-6">
          Your order
          <br />
          is confirmed.
        </h1>
        <p className="text-[15px] text-kvrn-muted leading-relaxed mb-4">
          A confirmation has been sent to your email. You&apos;ll receive
          another email with tracking once your order ships.
        </p>
        <p className="text-[14px] text-kvrn-muted leading-relaxed mb-12">
          Questions? Email{' '}
          <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity">
            hello@kvrn.com
          </a>
          .
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/shop"
            className="text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-6 h-12 inline-flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
          >
            Continue shopping
          </Link>
          <Link
            href="/"
            className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
          >
            Return home →
          </Link>
        </div>
      </div>
    </div>
  )
}
