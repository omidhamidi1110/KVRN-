// Public view of a published affiliate document. Flag-gated: with AFFILIATE_APPLICATIONS off this
// route does not exist. Shows the current version, or a specific published version via ?version=.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { sql } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { PageHero } from '@/components/layout/PageHero'
import { DocumentBody } from '../../_components/DocumentBody'
import { docTypeFromSlug } from '@/lib/affiliate-program-docs'
import { DOC_LABELS, getCurrentDocuments, type DocType } from '@/lib/affiliate-program'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Affiliate Program Document — KVRN', robots: { index: false, follow: false } }

export default async function AffiliateDocumentPage(
  { params, searchParams }: { params: Promise<{ docType: string }>; searchParams: Promise<{ version?: string }> },
) {
  if (!isFeatureEnabled('AFFILIATE_APPLICATIONS')) notFound()
  const { docType: slug } = await params
  const { version } = await searchParams
  const docType = docTypeFromSlug(slug) as DocType | null
  if (!docType) notFound()

  let doc: { title: string; version: string; effectiveAt: string | null; body: string; isPlaceholder: boolean } | null = null
  if (version && /^v[0-9]{1,6}$/.test(version)) {
    const rows = await sql`
      SELECT title, version, effective_at, body, is_placeholder FROM affiliate_documents
       WHERE doc_type = ${docType} AND version = ${version} AND published_at IS NOT NULL` as any[]
    if (rows[0]) doc = { title: rows[0].title, version: rows[0].version, effectiveAt: new Date(rows[0].effective_at).toISOString(), body: rows[0].body, isPlaceholder: !!rows[0].is_placeholder }
  } else {
    const cur = (await getCurrentDocuments(sql))[docType]
    if (cur) doc = { title: cur.title, version: cur.version, effectiveAt: cur.effectiveAt, body: cur.body, isPlaceholder: cur.isPlaceholder }
  }
  if (!doc) notFound()

  return (
    <div>
      <PageHero title={DOC_LABELS[docType]} breadcrumb="Affiliate Program" />
      <div data-nav-theme="light" className="container-kvrn section-padding max-w-2xl">
        <p className="label-11 text-kvrn-muted mb-8">
          Version {doc.version}{doc.effectiveAt ? ` · Effective ${new Date(doc.effectiveAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}` : ''}
        </p>
        {doc.isPlaceholder && (
          <p role="note" className="mb-8 border border-[#E8E5E0] bg-[#F9F8F6] px-4 py-3 text-[12px] text-kvrn-muted">
            This document is a draft that has not yet been reviewed. It is not final.
          </p>
        )}
        <DocumentBody body={doc.body} />
        <p className="mt-12 text-[12px]"><Link href="/affiliates/apply" className="underline underline-offset-2 text-kvrn-muted hover:text-kvrn-text">Back to the application</Link></p>
      </div>
    </div>
  )
}
