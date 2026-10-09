import Link from 'next/link'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Affiliate Login | KVRN', robots: { index: false, follow: false } }

export default function AffiliateEntry() {
  if (isFeatureEnabled('AFFILIATE_PORTAL')) redirect('/affiliate/login')
  return (
    <main className="min-h-[80svh] bg-[#F9F8F6] px-6 pb-24 pt-40 text-[#1A1A1A]">
      <div className="mx-auto max-w-lg">
        <p className="text-[11px] tracking-[0.2em] uppercase text-[#777]">KVRN / Affiliates</p>
        <h1 className="mt-5 text-4xl font-light">Affiliate Login</h1>
        <p className="mt-5 text-sm leading-7 text-[#555]">The affiliate portal is not open for sign-in yet. Approved partners will be able to request a secure email sign-in link once access is enabled.</p>
        <Link className="mt-8 inline-block border-b border-[#222] pb-1 text-sm" href="/contact">Contact KVRN Support</Link>
      </div>
    </main>
  )
}
