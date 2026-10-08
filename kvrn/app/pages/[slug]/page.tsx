// Generic pages created in Admin (/pages/<slug>). Exists only with KVRN_FLAG_CMS_PUBLIC_CONTENT on;
// off, every URL here is a 404. Only PUBLISHED pages resolve — drafts are previewed inside Admin.
// A renamed page 301s from its old slug (content_redirects).
import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { genericPageMetadata } from '@/lib/content-storefront'
import { GenericPageView } from '@/components/content/cms-views'

export const dynamic = 'force-dynamic'
type Props = { params: Promise<{ slug: string }> }

async function resolve(slug: string) {
  if (!cmsContentEnabled()) return { kind: 'none' as const }
  const s = slug.toLowerCase()
  const view = await contentPublic().getPageBySlug(s)
  if (view) return { kind: 'view' as const, view }
  const r = await contentPublic().findRedirect(`/pages/${s}`)
  return r ? { kind: 'redirect' as const, to: r.to } : { kind: 'none' as const }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve((await params).slug)
  return r.kind === 'view' ? genericPageMetadata(r.view) : { robots: { index: false, follow: false } }
}

export default async function CmsPage({ params }: Props) {
  const r = await resolve((await params).slug)
  if (r.kind === 'redirect') permanentRedirect(r.to)
  if (r.kind !== 'view') notFound()
  return <GenericPageView view={r.view} />
}
