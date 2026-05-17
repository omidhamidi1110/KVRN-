import type { Metadata } from 'next'
import Link from 'next/link'
import { products } from '@/data/products'
import { ProductCard } from '@/components/product/ProductCard'
import { WaitlistForm } from '@/components/forms/WaitlistForm'

export const metadata: Metadata = {
  title: 'KVRN — Engineered for Permanence',
  description:
    'KVRN. Heavyweight oversized fleece. 400 GSM+. Structured 3-panel hood. Concealed interior zippers. Built for daily wear.',
}

export default function HomePage() {
  return (
    <>
      {/* ═══════════════════════════════════════════════════════════
          HERO — Cinematic, brand-level. No drop references.
          Replace gradient with actual campaign imagery.
      ═══════════════════════════════════════════════════════════ */}
      <section
        className="relative w-full h-[100svh] overflow-hidden bg-[var(--color-bg-dark)] flex flex-col"
        aria-label="KVRN brand hero"
      >
        {/* Background — replace gradient with <Image> when campaign assets exist */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(160deg, #0E0E0E 0%, #1C1917 40%, #14120F 100%)',
          }}
          aria-hidden="true"
        />
        {/* Subtle texture overlay */}
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

        {/* Content — vertically centered, left-aligned */}
        <div className="relative flex-1 flex flex-col justify-end kvrn-container pb-14 md:pb-20">
          <div className="max-w-xl">
            <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-6">KVRN</p>
            <h1
              className="font-light text-[clamp(44px,7vw,96px)] leading-[0.95] tracking-[-0.03em] text-[var(--color-text-on-dark)] mb-8"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Engineered
              <br />
              for
              <br />
              permanence.
            </h1>
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <Link
                href="/shop"
                className="inline-flex items-center h-12 px-8 border border-[var(--color-text-on-dark)]/60 text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-text-on-dark)] hover:bg-[var(--color-text-on-dark)] hover:text-[var(--color-bg-dark)] transition-all duration-200"
              >
                Explore Collection
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

        {/* Scroll indicator */}
        <div className="relative kvrn-container pb-8 hidden md:flex items-center gap-3" aria-hidden="true">
          <span className="block w-8 h-px bg-[var(--color-text-on-dark)]/20" />
          <span className="text-[10px] font-light tracking-[0.2em] uppercase text-[var(--color-text-on-dark)]/30">
            Scroll
          </span>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 2 — Brand philosophy / material standards
          Brand-level content. Not collection-specific.
      ═══════════════════════════════════════════════════════════ */}
      <section className="section-y border-b border-[var(--color-border)]" aria-labelledby="standards-heading">
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-32 items-start">

            <div>
              <p className="kvrn-label mb-8" id="standards-heading">The Standard</p>
              <h2 className="text-[clamp(32px,4vw,56px)] font-light leading-[1.0] tracking-[-0.025em] mb-8">
                Built once.
                <br />
                Worn without thought.
              </h2>
              <p className="text-[15px] font-light text-[var(--color-muted)] leading-relaxed max-w-[400px]">
                Most garments are designed to be noticed. KVRN is designed to
                disappear into a life — heavy enough to have presence, considered
                enough to never demand attention.
              </p>
            </div>

            <div className="space-y-0">
              {[
                {
                  number: '01',
                  title:  '400 GSM+ Fleece',
                  body:   'Every batch tested. Minimum 390 GSM accepted. The weight is structural — perceptible from the first lift.',
                },
                {
                  number: '02',
                  title:  'Structured Architecture',
                  body:   'Three-panel hoods engineered to hold form without drawstrings. Design decisions made for permanence, not convenience.',
                },
                {
                  number: '03',
                  title:  'Hidden Utility',
                  body:   'Interior zipper compartments behind both pocket openings. Invisible externally. Functional absolutely.',
                },
                {
                  number: '04',
                  title:  'Minimal Mark',
                  body:   'A single moulded rubber patch on the hood. Nothing on the chest. Nothing on the sleeve. The garment speaks first.',
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

      {/* ═══════════════════════════════════════════════════════════
          SECTION 3 — Current collection
          Collection-aware. Update when new collections launch.
      ═══════════════════════════════════════════════════════════ */}
      <section className="section-y" aria-labelledby="collection-heading">
        <div className="kvrn-container">
          <div className="flex items-end justify-between mb-12 md:mb-16">
            <div>
              <p className="kvrn-label mb-3" id="collection-heading">Current Collection</p>
              <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-none tracking-tight">
                Heavyweight Fleece
              </h2>
            </div>
            <Link
              href="/shop"
              className="hidden md:inline-flex text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-150"
            >
              View all →
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
              View all →
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 4 — Manufacturing / process (dark)
          Brand story. No drop context.
      ═══════════════════════════════════════════════════════════ */}
      <section
        className="section-y bg-[var(--color-bg-dark)] text-[var(--color-text-on-dark)]"
        aria-labelledby="process-heading"
      >
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-32 items-center">

            {/* Text */}
            <div>
              <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-8" id="process-heading">
                The Process
              </p>
              <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-[1.05] tracking-tight mb-8">
                Every batch
                <br />
                tested before
                <br />
                it ships.
              </h2>
              <div className="space-y-5 text-[14px] font-light text-[var(--color-text-on-dark)]/60 leading-relaxed max-w-[380px]">
                <p>
                  We work with a single manufacturer. We know their process.
                  We have approved their sample at every production stage.
                </p>
                <p>
                  Every batch is fabric-tested before it enters stock. The 400 GSM
                  claim is verified by measurement, not assumed by specification sheet.
                </p>
                <p>
                  Below 390 GSM — it does not ship.
                </p>
              </div>
              <Link
                href="/about"
                className="inline-flex items-center mt-10 text-[11px] font-light tracking-[0.14em] uppercase text-[var(--color-text-on-dark)]/50 hover:text-[var(--color-text-on-dark)] transition-colors duration-150"
              >
                Read the full story →
              </Link>
            </div>

            {/* Specs grid */}
            <div className="grid grid-cols-2 gap-px bg-[var(--color-text-on-dark)]/10">
              {[
                { metric: '400 GSM+',    label: 'Minimum fabric weight' },
                { metric: '1',           label: 'Manufacturing partner' },
                { metric: '3-Panel',     label: 'Hood construction' },
                { metric: 'No marks.',   label: 'External branding policy' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="bg-[var(--color-bg-dark)] px-8 py-10"
                >
                  <p className="text-[clamp(24px,3vw,40px)] font-light tracking-tight text-[var(--color-text-on-dark)] mb-2 leading-none">
                    {item.metric}
                  </p>
                  <p className="text-[12px] font-light text-[var(--color-text-on-dark)]/40 leading-snug">
                    {item.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 5 — Waitlist / community
      ═══════════════════════════════════════════════════════════ */}
      <section className="section-y border-t border-[var(--color-border)]" aria-labelledby="waitlist-heading">
        <div className="kvrn-container max-w-lg">
          <p className="kvrn-label mb-6" id="waitlist-heading">Stay close</p>
          <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-none tracking-tight mb-6">
            New releases.
            <br />
            First access.
          </h2>
          <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed mb-10 max-w-sm">
            Join the list. Waitlist members receive new collection access 24 hours
            before the public — no spam, no noise.
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
