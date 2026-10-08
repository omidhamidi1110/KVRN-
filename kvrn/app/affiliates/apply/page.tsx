// Public affiliate application. Flag-gated (AFFILIATE_APPLICATIONS, default OFF): with the flag off
// this page does not exist. When the legal documents are not yet final the page says applications
// are closed instead of showing a form.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { PageHero } from '@/components/layout/PageHero'
import { getApplicationReadiness } from '@/lib/affiliate-program'
import { issueFormToken, loadApplyPageData } from '@/lib/affiliate-application'
import { ApplyClient } from './ApplyClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Become an Affiliate — KVRN',
  description: 'Apply to the KVRN affiliate program.',
  robots: { index: false, follow: false },
  // The invitation link carries its one-time token in the URL fragment, which is not sent in HTTP requests.
  referrer: 'no-referrer',
}

export default async function ApplyPage() {
  if (!isFeatureEnabled('AFFILIATE_APPLICATIONS')) notFound()
  const readiness = await getApplicationReadiness(sql)
  if (!readiness.open) {
    return (
      <div>
        <PageHero title="Become an Affiliate" breadcrumb="Affiliate Program" />
        <div data-nav-theme="light" className="container-kvrn section-padding max-w-xl">
          <p className="text-[14px] text-kvrn-muted leading-relaxed">
            Applications are not open right now. Please check back soon.
          </p>
        </div>
      </div>
    )
  }
  const { docs, countries } = await loadApplyPageData(sql)
  const pick = (t: 'program_terms' | 'disclosure_policy' | 'privacy_notice') => ({ version: docs[t]!.version, title: docs[t]!.title })
  return (
    <div>
      <PageHero title="Become an Affiliate" breadcrumb="Affiliate Program" />
      <ApplyClient
        formToken={await issueFormToken()}
        countries={countries}
        docs={{ terms: pick('program_terms'), disclosure: pick('disclosure_policy'), privacy: pick('privacy_notice') }}
      />
    </div>
  )
}
