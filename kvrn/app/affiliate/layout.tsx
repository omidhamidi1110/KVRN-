import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { isFeatureEnabled } from '@/lib/feature-flags'

// Private, per-person pages: never indexed, never cached, no Referer sent on outbound navigation.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Affiliate portal',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
}

export default function AffiliateLayout({ children }: { children: ReactNode }) {
  // Flag OFF: this whole area does not exist.
  if (!isFeatureEnabled('AFFILIATE_PORTAL')) notFound()
  // A full-screen surface so the storefront chrome (nav, banners, footer) does not frame a private portal.
  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-[#F5F3EF] text-[#171717]" data-affiliate-portal>
      <div className="mx-auto w-full max-w-[920px] px-4 pb-16 pt-6 sm:px-6">
        <div className="mb-6 text-[13px] font-bold tracking-[0.2em]">KVRN <span className="font-normal tracking-normal text-[#6B6B66]">Affiliates</span></div>
        {children}
      </div>
    </div>
  )
}
