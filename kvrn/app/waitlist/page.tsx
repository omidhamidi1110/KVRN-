import type { Metadata } from 'next'
import { WaitlistForm } from '@/components/forms/WaitlistForm'

export const metadata: Metadata = {
  title: 'Waitlist — KVRN',
  description: 'Join the KVRN waitlist for early access to new drops and collection announcements.',
}

export default function WaitlistPage() {
  return (
    <div className="min-h-screen bg-[#0E0E0E] flex flex-col" aria-labelledby="waitlist-heading">
      {/* Full-height dark canvas */}
      <div className="flex-1 flex items-center">
        <div className="container-kvrn w-full pt-[calc(36px+56px+60px)] pb-20">
          <div className="max-w-lg">

            <p className="text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8]/40 mb-10">
              KVRN
            </p>

            <h1
              id="waitlist-heading"
              className="font-display font-light text-[clamp(48px,8vw,88px)] leading-[0.9] tracking-[-0.03em] text-[#F0EDE8] mb-8"
            >
              Built for daily wear.<br />Designed for permanence.
            </h1>

            <p className="text-[15px] font-light text-[#F0EDE8]/50 leading-relaxed mb-3 max-w-[360px]">
              Get early access. Be first for every drop.
            </p>
            <p className="text-[13px] font-light text-[#F0EDE8]/30 mb-12">
              Collection access only. Unsubscribe any time.
            </p>

            <WaitlistForm
              variant="dark"
              heading=""
              subheading=""
              source="waitlist_page"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[#F0EDE8]/10">
        <div className="container-kvrn py-5 flex items-center justify-between">
          <p className="text-[11px] font-light text-[#F0EDE8]/25 tracking-wide">
            Drop notifications only. No spam.
          </p>
          <p className="text-[11px] font-light text-[#F0EDE8]/25 tracking-wide">
            © {new Date().getFullYear()} KVRN
          </p>
        </div>
      </div>
    </div>
  )
}
