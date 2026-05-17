import type { Metadata } from 'next'
import { WaitlistForm } from '@/components/forms/WaitlistForm'

export const metadata: Metadata = {
  title: 'Waitlist — KVRN',
  description:
    'Join the KVRN waitlist. Be first to know when Drop 002 goes live.',
}

export default function WaitlistPage() {
  return (
    <div className="min-h-screen bg-kvrn-bg-dark pt-[56px] flex flex-col">
      <div className="flex-1 container-kvrn flex items-center">
        <div className="w-full max-w-lg py-24 md:py-32">
          <p className="label-11 text-kvrn-text-on-dark/50 mb-4">KVRN</p>

          <h1 className="font-display font-light text-[48px] md:text-[64px] leading-none tracking-tighter text-kvrn-text-on-dark mb-6">
            Join
            <br />
            the list.
          </h1>

          <p className="text-[15px] text-kvrn-text-on-dark/60 mb-10 max-w-[380px] leading-relaxed">
            Drop 001 is available now. Drop 002 is in production.
            Be first — waitlist members are notified 24 hours before the public.
          </p>

          <WaitlistForm
            variant="dark"
            heading=""
            subheading=""
            source="waitlist_page"
          />
        </div>
      </div>

      {/* Footer strip */}
      <div className="border-t border-white/10 py-6 container-kvrn">
        <p className="text-[11px] text-kvrn-text-on-dark/30 tracking-wide">
          Drop notifications only. No spam. Unsubscribe any time.
        </p>
      </div>
    </div>
  )
}
