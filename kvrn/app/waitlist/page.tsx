import type { Metadata } from 'next'
import { WaitlistForm } from '@/components/forms/WaitlistForm'

export const metadata: Metadata = {
  title: 'Waitlist — KVRN',
  description: 'Join the KVRN waitlist. Early access to new collections and release announcements.',
}

export default function WaitlistPage() {
  return (
    <div
      className="min-h-screen bg-[var(--color-bg-dark)] pt-[calc(36px+56px)] flex flex-col"
      aria-labelledby="waitlist-heading"
    >
      <div className="flex-1 flex items-center kvrn-container">
        <div className="w-full max-w-md py-24 md:py-32">

          <p className="kvrn-label text-[#F0EDE8]/50 mb-8">KVRN</p>

          <h1
            id="waitlist-heading"
            className="text-[clamp(44px,7vw,80px)] font-light leading-[0.92] tracking-[-0.03em] text-[var(--color-text-on-dark)] mb-6"
          >
            First.
          </h1>

          <p className="text-[15px] font-light text-[#C8C4BF] leading-relaxed mb-12 max-w-[320px]">
            Waitlist members receive collection announcements and early access
            before public release. Nothing else. No noise.
          </p>

          <WaitlistForm
            variant="dark"
            heading=""
            subheading=""
            source="waitlist_page"
          />
        </div>
      </div>

      <div className="border-t border-[var(--color-text-on-dark)]/10 kvrn-container py-6">
        <p className="text-[11px] font-light text-[#F0EDE8]/40 tracking-wide">
          Collection notifications only. Unsubscribe any time.
        </p>
      </div>
    </div>
  )
}
