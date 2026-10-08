// Collections created in Admin (/collections/<slug>). Exists only with KVRN_FLAG_CMS_PUBLIC_CONTENT
// on; off, every URL here is a 404 (/collections/project-kvrn keeps its own coded page).
// Inactive / archived collections 404; a renamed collection 301s from its old slug.
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, permanentRedirect } from 'next/navigation'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { pageMetadata } from '@/lib/content-seo'
import { PageHero } from '@/components/layout/PageHero'
import { CollectionGrid } from '@/components/content/CollectionGrid'

export const dynamic = 'force-dynamic'
type Props = { params: Promise<{ slug: string }> }

async function resolve(slug: string) {
  if (!cmsContentEnabled()) return { kind: 'none' as const }
  const s = slug.toLowerCase()
  const c = await contentPublic().getCollection(s)
  if (c) return { kind: 'view' as const, c }
  const r = await contentPublic().findRedirect(`/collections/${s}`)
  return r ? { kind: 'redirect' as const, to: r.to } : { kind: 'none' as const }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve((await params).slug)
  if (r.kind !== 'view') return { robots: { index: false, follow: false } }
  const t = r.c.text.en
  return pageMetadata({ title: `${t.name} — KVRN`, description: t.description || undefined },
    { ...r.c.seo, title: t.seoTitle || undefined, description: t.seoDescription || undefined } as any, r.c.shareImageUrl ?? r.c.hero?.url ?? null)
}

export default async function CollectionPage({ params }: Props) {
  const r = await resolve((await params).slug)
  if (r.kind === 'redirect') permanentRedirect(r.to)
  if (r.kind !== 'view') notFound()
  const { c } = r
  return (
    <div>
      <PageHero title={c.text.en.name} breadcrumb={c.text.en.name} />
      <div data-nav-theme="light" className="container-kvrn max-w-5xl py-12">
        {c.hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.hero.url} alt={c.hero.alt} className="w-full h-auto mb-10" />
        )}
        <CollectionGrid text={c.text} products={c.products} />
        {c.products.length === 0 && (
          <p className="text-[14px] text-[#6B6B6B]">Nothing here yet. <Link href="/shop" className="underline underline-offset-2 text-[#1A1A1A]">Browse the shop</Link>.</p>
        )}
      </div>
    </div>
  )
}
