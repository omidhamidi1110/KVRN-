import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero } from '@/components/layout/PageHero'
import { PrivacyChoicesClient } from './PrivacyChoicesClient'

export const metadata: Metadata = {
  title: 'Your Privacy Choices — KVRN',
  description: 'Manage optional analytics and privacy preferences on KVRN.',
  alternates: { canonical: '/privacy-choices' },
  robots: { index: false, follow: false },
}

/** October 6 policy copy. No server-side sale/sharing request is implied by browser controls. */
export default function PrivacyChoicesPage() {
  return (
    <div>
      <PageHero title="Your Privacy Choices" breadcrumb="Your Privacy Choices" />
      <article data-nav-theme="light" className="container-kvrn max-w-3xl section-padding space-y-7 text-[14px] leading-relaxed text-[#6B6B6B]">
        <p className="text-xs uppercase tracking-wider">Last updated: October 6, 2026</p>
        <p>KVRN gives you controls over optional tracking, marketing communications, and certain uses of personal information.</p>
        <h2 className="text-lg text-[#1A1A1A]">Current status</h2>
        <p>KVRN does not sell personal information for money and does not currently share personal information for cross-context behavioral advertising in a manner KVRN treats as “sharing” under California privacy law.</p>
        <p>KVRN does not sell or share SMS opt-in data, mobile telephone numbers, or SMS consent information with third parties or affiliates for their own marketing or promotional purposes.</p>
        <PrivacyChoicesClient />
        <h2 className="text-lg text-[#1A1A1A]">Do not sell or share</h2>
        <p>If KVRN later engages in activity that gives you a legal right to opt out of sale or sharing, this page and the site’s privacy controls will be updated so you can exercise that choice. KVRN will honor qualifying Global Privacy Control signals where required by applicable law.</p>
        <h2 className="text-lg text-[#1A1A1A]">SMS choices</h2>
        <p>Reply STOP to stop KVRN marketing texts. You may also contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> to revoke SMS marketing consent. KVRN may retain suppression records to honor the request.</p>
        <h2 className="text-lg text-[#1A1A1A]">Email choices</h2>
        <p>Use the unsubscribe link in KVRN marketing emails. Unsubscribing does not stop transactional or service-related communications about orders or existing requests.</p>
        <h2 className="text-lg text-[#1A1A1A]">Privacy requests</h2>
        <p>Depending on applicable law, you may request access, deletion, correction, or other actions. Email <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> or use the <Link href="/contact" className="underline">Contact page</Link> and identify your request as a privacy request. You do not need a customer account. KVRN may need to verify your identity.</p>
        <p>For details, see the <Link href="/privacy" className="underline">KVRN Privacy Policy</Link> and <Link href="/cookies" className="underline">Cookie Policy</Link>.</p>
      </article>
    </div>
  )
}
