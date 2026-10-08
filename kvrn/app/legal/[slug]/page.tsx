// Custom policy pages created in Admin (/legal/<slug>). Exists only with
// KVRN_FLAG_CMS_PUBLIC_CONTENT on; off, every URL here is a 404 (as before this route existed).
// /legal/terms and /legal/privacy have their own (legacy alias) pages and win over this route.
import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { policyMetadata } from '@/lib/content-storefront'
import { PolicyView } from '@/components/content/cms-views'

export const dynamic = 'force-dynamic'
type Props = { params: Promise<{ slug: string }> }

async function resolve(slug: string) {
  if (!cmsContentEnabled()) return { kind: 'none' as const }
  const view = await contentPublic().getPolicyBySlug(slug.toLowerCase())
  if (view) {
    // A legacy policy lives at its own URL; this one is only the alias.
    if (view.path && view.path !== `/legal/${view.slug}`) return { kind: 'redirect' as const, to: view.path }
    return { kind: 'view' as const, view }
  }
  const r = await contentPublic().findRedirect(`/legal/${slug.toLowerCase()}`)
  return r ? { kind: 'redirect' as const, to: r.to, status: r.status } : { kind: 'none' as const }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve((await params).slug)
  return r.kind === 'view' ? policyMetadata(r.view, {}) : {}
}

export default async function LegalPolicyPage({ params }: Props) {
  const r = await resolve((await params).slug)
  if (r.kind === 'redirect') permanentRedirect(r.to)
  if (r.kind !== 'view') notFound()
  return <PolicyView view={r.view} />
}
