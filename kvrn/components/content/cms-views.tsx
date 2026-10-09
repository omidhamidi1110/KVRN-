// Server-rendered storefront views for Admin-managed content (only used with CMS_PUBLIC_CONTENT on).
// Each view renders one variant per language that has published translations and lets the
// client-side <LocaleSwitch> show the visitor's language (English when there is none).

import Link from 'next/link'
import type { ReactNode } from 'react'
import { PageHero } from '@/components/layout/PageHero'
import { Accordion } from '@/components/ui/Accordion'
import { CookieControls } from '@/app/cookies/CookieControls'
import { LocaleSwitch } from './LocaleSwitch'
import { SizeGuideClient, type SizeGuideVM, type GuideVM } from './SizeGuideClient'
import { renderRichText, type RichVariant } from './render-richtext'
import type { View } from '@/lib/content-public'
import type { Variant } from '@/lib/content-localize'
import type { PolicySnapshot, FaqSnapshot, AboutSnapshot, PageSnapshot, SizeGuideSnapshot, SupportPageSnapshot } from '@/lib/content-schemas'
import type { RichText } from '@/lib/content-richtext'
import { isInternalHref } from '@/lib/content-urls'

type AnyView<T> = View<T>

function ctxFor<T>(view: AnyView<T>, locale: string, variant: RichVariant) {
  return {
    variant, media: view.media,
    blocks: view.blocks[locale] ?? view.blocks.en ?? {},
    embeds: { 'cookie-controls': <CookieControls /> },
  }
}

const rich = <T,>(view: AnyView<T>, locale: string, doc: RichText | undefined, variant: RichVariant) =>
  renderRichText(doc, ctxFor(view, locale, variant))

function switcher<T>(view: AnyView<T>, render: (v: Variant<T>, locale: string) => ReactNode) {
  const nodes: Record<string, ReactNode> = {}
  for (const [locale, v] of Object.entries(view.variants)) nodes[locale] = render(v, locale)
  return <LocaleSwitch variants={nodes} />
}

/** 'YYYY-MM-DD' → "12 August 2026" (English: day-month order as the coded pages show). */
export function formatPolicyDate(iso: string, locale: string): string {
  try {
    const d = new Date(`${iso}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
  } catch { return iso }
}

// ── Policies ──────────────────────────────────────────────────────────────────

export function PolicyView({ view }: { view: AnyView<PolicySnapshot> }) {
  return switcher(view, (v, locale) => {
    const p = v.data
    if (p.style === 'support') {
      return (
        <div>
          <PageHero title={p.heroTitle || p.title} breadcrumb={p.heroBreadcrumb || p.title} />
          <div data-nav-theme="light" className="container-kvrn section-padding max-w-3xl">
            {rich(view, locale, p.body, 'support')}
          </div>
        </div>
      )
    }
    return (
      <div>
        <PageHero title={p.heroTitle || p.title} breadcrumb={p.heroBreadcrumb || p.title} />
        <div className="pt-0">
          <article aria-label={p.title} data-nav-theme="light" className="container-kvrn section-padding max-w-2xl">
            {p.effectiveDate && (
              <p className="label-11 text-kvrn-muted mb-14">{p.lastUpdatedLabel || 'Last updated'}: {formatPolicyDate(p.effectiveDate, locale)}</p>
            )}
            {rich(view, locale, p.body, 'legal')}
          </article>
        </div>
      </div>
    )
  })
}

// ── Generic page ──────────────────────────────────────────────────────────────

export function GenericPageView({ view }: { view: AnyView<PageSnapshot> }) {
  return switcher(view, (v, locale) => (
    <div>
      <PageHero title={v.data.title} breadcrumb={v.data.title} />
      <div data-nav-theme="light" className="container-kvrn section-padding max-w-3xl">
        {v.data.subtitle && <p className="text-[16px] font-light text-[#1A1A1A] leading-relaxed mb-10">{v.data.subtitle}</p>}
        {rich(view, locale, v.data.body, 'plain')}
      </div>
    </div>
  ))
}

// ── FAQ ───────────────────────────────────────────────────────────────────────

export function FaqView({ view }: { view: AnyView<FaqSnapshot> }) {
  return switcher(view, (v, locale) => {
    const f = v.data
    const cats = f.categories.filter(c => c.active && c.items.some(i => i.active))
    return (
      <div>
        <PageHero title={f.heroTitle} breadcrumb={f.heroTitle} />
        <div data-nav-theme="light" className="container-kvrn max-w-3xl py-14">
          {cats.map(c => (
            <section key={c.id} className="mb-12 last:mb-0">
              <h2 className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-5 pb-3 border-b border-[#E8E5E0]">{c.heading}</h2>
              <Accordion items={c.items.filter(i => i.active).map(i => ({
                id: i.id, trigger: i.question, content: rich(view, locale, i.answer, 'faq'),
              }))} />
            </section>
          ))}
          {(f.footerTitle || f.footerBody.blocks.length > 0) && (
            <div className="mt-12 pt-8 border-t border-[#E8E5E0]">
              {f.footerTitle && <p className="text-[14px] font-light mb-1">{f.footerTitle}</p>}
              {rich(view, locale, f.footerBody, 'faq')}
            </div>
          )}
        </div>
      </div>
    )
  })
}

// ── About ─────────────────────────────────────────────────────────────────────

export function AboutView({ view }: { view: AnyView<AboutSnapshot> }) {
  return switcher(view, (v) => {
    const a = v.data
    const img = a.imageAssetId ? view.media[a.imageAssetId] : undefined
    const external = !isInternalHref(a.ctaHref)
    return (
      <div className="min-h-screen bg-[#F9F8F6]">
        <PageHero title={a.heroTitle} breadcrumb={a.heroTitle} />
        <div data-nav-theme="light" className="container-kvrn max-w-3xl py-16 md:py-20">
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img.url} alt={a.imageAlt || img.alt} loading="lazy" className="w-full h-auto mb-12" />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-16">
            <div className="space-y-6">
              {a.brandEyebrow && <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">{a.brandEyebrow}</p>}
              {a.lead && <p className="text-[16px] font-light text-[#1A1A1A] leading-relaxed">{a.lead}</p>}
              {a.brandParagraphs.map((t, i) => <p key={i} className="text-[14px] text-[#6B6B6B] leading-relaxed">{t}</p>)}
            </div>
            <div className="space-y-6">
              {a.approachEyebrow && <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">{a.approachEyebrow}</p>}
              <div className="space-y-4">
                {a.approach.map(x => (
                  <div key={x.id} className="pb-4 border-b border-[#E8E5E0] last:border-0 last:pb-0">
                    <p className="text-[13px] font-light text-[#1A1A1A] mb-1">{x.title}</p>
                    <p className="text-[13px] text-[#6B6B6B] leading-relaxed">{x.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {a.ctaLabel && (
            <div className="mt-16 pt-10 border-t border-[#E8E5E0]">
              <Link href={a.ctaHref} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300">
                {a.ctaLabel}
              </Link>
            </div>
          )}
        </div>
      </div>
    )
  })
}

// ── Size guide ────────────────────────────────────────────────────────────────

export function SizeGuidePageView({ page, guides }: { page: AnyView<SupportPageSnapshot>; guides: Array<AnyView<SizeGuideSnapshot>> }) {
  const locales = new Set<string>(['en', ...Object.keys(page.variants), ...guides.flatMap(g => Object.keys(g.variants))])
  const vms: Record<string, SizeGuideVM> = {}
  for (const locale of locales) {
    const pv = page.variants[locale] ?? page.variants.en
    vms[locale] = {
      intro: pv.data.intro,
      tip: rich(page, locale in page.variants ? locale : 'en', pv.data.tip, 'support'),
      links: pv.data.links,
      guides: guides.map((g): GuideVM => {
        const gl = g.variants[locale] ? locale : 'en'
        const s = g.variants[gl].data
        const m = s.imageAssetId ? g.media[s.imageAssetId] : undefined
        return {
          id: g.id, name: s.name, unit: s.unit, rowHeader: s.rowHeader, columns: s.columns, rows: s.rows, notes: s.notes,
          shopLink: s.shopLink, image: m ? { url: m.url, alt: s.imageAlt || m.alt } : undefined,
          fit: s.fit.blocks.length ? rich(g, gl, s.fit, 'support') : null,
        }
      }),
    }
  }
  return (
    <div>
      <PageHero title={(page.variants.en).data.heroTitle} breadcrumb={(page.variants.en).data.heroTitle} />
      <div data-nav-theme="light" className="container-kvrn max-w-3xl py-12">
        <SizeGuideClient variants={vms} />
      </div>
    </div>
  )
}
