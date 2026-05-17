import type { Metadata } from 'next'
import Link from 'next/link'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'
import { WaitlistForm } from '@/components/forms/WaitlistForm'

export const metadata: Metadata = {
  title: 'KVRN — Designed Slowly. Built to Remain.',
  description:
    'KVRN is a clothing brand focused on permanence, considered silhouettes, and heavyweight construction.',
}

export default function HomePage() {
  return (
    <>
      {/* ═══════════════════════════════════════════════════
          SECTION 1 — HERO
          Brand identity only. Timeless. No collection refs.
      ═══════════════════════════════════════════════════ */}
      <section
        className="relative w-full h-[100svh] overflow-hidden bg-[var(--color-bg-dark)] flex flex-col"
        aria-label="KVRN brand hero"
      >
        {/* Background — replace with <Image> when campaign assets exist */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(160deg, #0E0E0E 0%, #1C1917 40%, #14120F 100%)',
          }}
          aria-hidden="true"
        />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `repeating-linear-gradient(
              0deg, transparent, transparent 1px,
              rgba(255,255,255,0.4) 1px, rgba(255,255,255,0.4) 2px
            )`,
            backgroundSize: '100% 3px',
          }}
          aria-hidden="true"
        />

        <div className="relative flex-1 flex flex-col justify-end kvrn-container pb-14 md:pb-20">
          <div className="max-w-xl">
            <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-6">KVRN</p>
            <h1
              className="font-light text-[clamp(44px,7vw,96px)] leading-[0.95] tracking-[-0.03em] text-[var(--color-text-on-dark)] mb-8"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Designed slowly.
              <br />
              Built to remain.
            </h1>
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <Link
                href="/shop"
                className="inline-flex items-center h-12 px-8 border border-[var(--color-text-on-dark)]/60 text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-text-on-dark)] hover:bg-[var(--color-text-on-dark)] hover:text-[var(--color-bg-dark)] transition-all duration-200"
              >
                Shop Now
              </Link>
              <Link
                href="/about"
                className="inline-flex items-center h-12 px-2 text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-text-on-dark)]/50 hover:text-[var(--color-text-on-dark)] transition-colors duration-200"
              >
                About KVRN →
              </Link>
            </div>
          </div>
        </div>

        <div className="relative kvrn-container pb-8 hidden md:flex items-center gap-3" aria-hidden="true">
          <span className="block w-8 h-px bg-[var(--color-text-on-dark)]/20" />
          <span className="text-[10px] font-light tracking-[0.2em] uppercase text-[var(--color-text-on-dark)]/30">
            Scroll
          </span>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SECTION 2 — BRAND PHILOSOPHY
          Intentional. Timeless. No technical claims.
      ═══════════════════════════════════════════════════ */}
      <section className="section-y border-b border-[var(--color-border)]" aria-labelledby="philosophy-heading">
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-32 items-start">

            <div>
              <p className="kvrn-label mb-8" id="philosophy-heading">The Approach</p>
              <h2 className="text-[clamp(32px,4vw,56px)] font-light leading-[1.0] tracking-[-0.025em] mb-8">
                Built once.
                <br />
                Worn without thought.
              </h2>
              <p className="text-[15px] font-light text-[var(--color-muted)] leading-relaxed max-w-[400px]">
                Most garments are designed to be noticed. KVRN is designed to
                disappear into a life — present enough to matter, considered
                enough to never demand attention.
              </p>
            </div>

            <div className="space-y-0">
              {[
                {
                  number: '01',
                  title:  'Intentional Design',
                  body:   'Every detail exists for a reason. Proportions are deliberate. Construction decisions are made for longevity, not trend.',
                },
                {
                  number: '02',
                  title:  'Heavyweight Construction',
                  body:   'Developed around fabrics with real weight and structure. Garments that hold their form, season after season.',
                },
                {
                  number: '03',
                  title:  'Considered Silhouette',
                  body:   'Oversized without being shapeless. Structured without being rigid. A silhouette designed to improve with wear.',
                },
                {
                  number: '04',
                  title:  'Slower Releases',
                  body:   'Collections take time. KVRN releases when the work is ready — not on a calendar.',
                },
              ].map((item) => (
                <div
                  key={item.number}
                  className="flex gap-8 py-7 border-b border-[var(--color-border)] last:border-0"
                >
                  <span className="kvrn-label text-[var(--color-muted)] pt-0.5 flex-shrink-0 w-6">
                    {item.number}
                  </span>
                  <div>
                    <p className="text-[14px] font-light mb-2">{item.title}</p>
                    <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SECTION 3 — FEATURED COLLECTION
          Drop-aware. Update label when next drop launches.
      ═══════════════════════════════════════════════════ */}
      <section className="section-y" aria-labelledby="collection-heading">
        <div className="kvrn-container">
          <div className="flex items-end justify-between mb-12 md:mb-16">
            <div>
              <p className="kvrn-label mb-3" id="collection-heading">Drop 001</p>
              <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-none tracking-tight">
                Heavyweight Collection
              </h2>
            </div>
            <Link
              href="/shop"
              className="hidden md:inline-flex text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
            >
              Shop collection →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-10">
            {products.map((product, i) => (
              <ProductCard key={product.id} product={product} priority={i === 0} />
            ))}
          </div>

          <div className="mt-10 md:hidden">
            <Link
              href="/shop"
              className="text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              Shop collection →
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SECTION 4 — MATERIALS TEASER (dark)
          Teaser only. No specific claims or measurements.
      ═══════════════════════════════════════════════════ */}
      <section
        className="section-y bg-[var(--color-bg-dark)] text-[var(--color-text-on-dark)]"
        aria-labelledby="materials-heading"
      >
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-32 items-center">

            <div>
              <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-8" id="materials-heading">
                Materials & Process
              </p>
              <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-[1.05] tracking-tight mb-8">
                Developed around
                <br />
                heavyweight fabrics
                <br />
                and structured form.
              </h2>
              <div className="space-y-5 text-[14px] font-light text-[var(--color-text-on-dark)]/60 leading-relaxed max-w-[380px]">
                <p>
                  Each collection is built around a considered set of materials —
                  chosen for weight, structure, and longevity rather than season
                  or trend.
                </p>
                <p>
                  Construction details are released with each drop.
                  Full material specifications are on every product page.
                </p>
              </div>
              <Link
                href="/about"
                className="inline-flex items-center mt-10 text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-text-on-dark)]/50 hover:text-[var(--color-text-on-dark)] transition-colors duration-150"
              >
                Read about KVRN →
              </Link>
            </div>

            {/* Four brand pillars — no specific metrics */}
            <div className="grid grid-cols-2 gap-px bg-[var(--color-text-on-dark)]/10">
              {[
                { label: 'Heavyweight construction' },
                { label: 'Structured proportions' },
                { label: 'Minimal branding' },
                { label: 'Considered silhouette' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="bg-[var(--color-bg-dark)] px-8 py-10 flex items-end"
                >
                  <p className="text-[13px] font-light text-[var(--color-text-on-dark)]/50 leading-snug">
                    {item.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          SECTION 5 — WAITLIST
      ═══════════════════════════════════════════════════ */}
      <section className="section-y border-t border-[var(--color-border)]" aria-labelledby="waitlist-heading">
        <div className="kvrn-container max-w-lg">
          <p className="kvrn-label mb-6" id="waitlist-heading">Stay informed</p>
          <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-none tracking-tight mb-6">
            New releases.
            <br />
            Early access.
          </h2>
          <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed mb-10 max-w-sm">
            Join the list for new collection announcements, release details,
            and early access — before anything goes public.
          </p>
          <WaitlistForm
            variant="light"
            heading=""
            subheading=""
            source="homepage"
          />
        </div>
      </section>
    </>
  )
}
