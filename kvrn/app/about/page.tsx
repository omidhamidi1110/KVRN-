import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'About — KVRN',
  description:
    'KVRN. Quiet luxury meets premium utility. The story, the standard, and the reason.',
}

export default function AboutPage() {
  return (
    <div className="pt-[60px]">

      {/* ─── Hero manifesto ─── */}
      <section
        className="section-y bg-[var(--color-bg-dark)] text-[var(--color-text-on-dark)]"
        aria-labelledby="about-hero"
      >
        <div className="kvrn-container max-w-4xl">
          <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-12">KVRN</p>
          <h1
            id="about-hero"
            className="text-[clamp(44px,7vw,96px)] font-light leading-[0.92] tracking-[-0.03em] mb-16"
          >
            Silence.
            <br />
            Weight.
            <br />
            Presence.
          </h1>
          <p className="text-[17px] md:text-[20px] font-light text-[var(--color-text-on-dark)]/60 leading-relaxed max-w-[520px]">
            KVRN exists because most clothing that calls itself premium is not.
            The GSM number is overstated. The construction is compromised.
            The branding does the work the fabric cannot.
          </p>
        </div>
      </section>

      {/* ─── The problem ─── */}
      <section className="section-y border-b border-[var(--color-border)]" aria-labelledby="problem-heading">
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-16">
            <div>
              <p className="kvrn-label mb-4" id="problem-heading">The problem</p>
            </div>
            <div className="space-y-6 text-[16px] font-light text-[var(--color-muted)] leading-relaxed max-w-[600px]">
              <p>
                300 GSM is sold as heavyweight. 320 GSM is called premium.
                350 GSM ships with a campaign photo and a story about craftsmanship.
                The word is inflated. The fabric is ordinary.
              </p>
              <p>
                A single-panel hood collapses without a drawstring — so a drawstring is added,
                and the silhouette becomes provisional. A chest logo is applied
                because the garment cannot communicate quality on its own.
              </p>
              <p>
                We declined to make any of these compromises.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── The standard ─── */}
      <section className="section-y border-b border-[var(--color-border)]" aria-labelledby="standard-heading">
        <div className="kvrn-container">
          <p className="kvrn-label mb-12 md:mb-16" id="standard-heading">The standard</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--color-border)]">
            {[
              {
                heading: 'The weight.',
                body:     '400 GSM+ loopback terry. Tested per batch. Every batch. Minimum 390 GSM accepted. Below that — it does not ship.',
              },
              {
                heading: 'The hood.',
                body:     'Three panels. Seamed to form a dome. No drawstring required. No drawstring installed. The structure is the solution.',
              },
              {
                heading: 'The utility.',
                body:     'Interior zipper compartments behind both kangaroo pocket openings. Invisible from outside. Functional in every position.',
              },
              {
                heading: 'The mark.',
                body:     'One moulded rubber patch on the hood exterior. No chest logo. No sleeve hit. No hang tag with a manifesto. The garment first.',
              },
            ].map((item) => (
              <div key={item.heading} className="bg-[var(--color-bg)] px-8 py-10 md:py-12">
                <p className="text-[15px] font-light mb-4">{item.heading}</p>
                <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── The materials ─── */}
      <section className="section-y border-b border-[var(--color-border)] bg-[var(--color-bg-raised)]" aria-labelledby="materials-heading">
        <div className="kvrn-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-32 items-start">
            <div>
              <p className="kvrn-label mb-6" id="materials-heading">Materials</p>
              <h2 className="text-[clamp(28px,3.5vw,48px)] font-light leading-none tracking-tight mb-8">
                100% ring-spun
                <br />
                combed cotton.
                <br />
                Nothing else.
              </h2>
              <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed max-w-[380px]">
                Ring-spun yarn is stronger and softer than standard spun cotton — the
                fibres are continuously twisted and thinned during processing.
                Combing removes short fibres and impurities. The result is a denser,
                more durable, cleaner yarn.
              </p>
              <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed mt-4 max-w-[380px]">
                No polyester. No blends added to reduce cost or improve marketing copy.
              </p>
            </div>
            <div className="space-y-0">
              {[
                { label: 'Fibre',         value: '100% ring-spun combed cotton' },
                { label: 'Weight',        value: '400 GSM+ (tested per batch)' },
                { label: 'Construction',  value: 'Loopback terry, triple-brushed interior' },
                { label: 'Face',          value: 'Dense, cold-resist smooth' },
                { label: 'Interior',      value: 'Triple-brushed for immediate warmth' },
                { label: 'Shrinkage',     value: 'Pre-shrunk to less than 3%' },
                { label: 'Care',          value: 'Machine wash cold. Air dry.' },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-8 py-4 border-b border-[var(--color-border)] last:border-0"
                >
                  <span className="kvrn-label text-[var(--color-muted)]">{row.label}</span>
                  <span className="text-[14px] font-light text-right">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── The design logic ─── */}
      <section className="section-y border-b border-[var(--color-border)]" aria-labelledby="design-heading">
        <div className="kvrn-container max-w-3xl">
          <p className="kvrn-label mb-12" id="design-heading">Design logic</p>
          <div className="space-y-12">
            {[
              {
                q: 'Why no drawstring?',
                a: 'A drawstring exists because the hood structure is insufficient to maintain its form independently. We built a hood structure — three separate panels seamed to create a self-supporting dome — that does not require external support. The drawstring is therefore unnecessary. Its absence is a consequence of solving the problem correctly.',
              },
              {
                q: 'Why interior zippers?',
                a: 'A standard kangaroo pocket holds items that move freely and can fall. An interior zipper pocket holds items that stay. The zipper runs parallel to the pocket opening — invisible from outside, accessible from inside. Both sides. It costs more to produce. It is worth it.',
              },
              {
                q: 'Why no visible branding?',
                a: 'Visible branding on a garment performs a function: it communicates that the person wearing it values the label more than the object. KVRN is designed for the opposite — for the person who wants the best version of the thing, not the loudest version of the name. One rubber patch on the hood. Nothing else needs to be said.',
              },
              {
                q: 'Why 400 GSM when 300 is sufficient?',
                a: 'At 300 GSM, a hoodie is functional. At 400 GSM+, it becomes structural — it holds its shape, drapes rather than hangs, and maintains its weight and presence after years of wear. The difference is perceptible immediately. There is no argument for the lesser weight.',
              },
            ].map((item) => (
              <div
                key={item.q}
                className="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-6 md:gap-12 pb-12 border-b border-[var(--color-border)] last:border-0 last:pb-0"
              >
                <p className="text-[15px] font-light">{item.q}</p>
                <p className="text-[14px] font-light text-[var(--color-muted)] leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── What KVRN is not ─── */}
      <section className="section-y border-b border-[var(--color-border)] bg-[var(--color-bg-dark)] text-[var(--color-text-on-dark)]" aria-labelledby="position-heading">
        <div className="kvrn-container">
          <p className="kvrn-label text-[var(--color-text-on-dark)]/40 mb-12" id="position-heading">
            The position
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-16 md:gap-32 max-w-3xl">
            <div>
              <p className="kvrn-label text-[var(--color-text-on-dark)]/60 mb-6">KVRN is</p>
              <ul className="space-y-0">
                {['Architectural', 'Heavyweight', 'Minimal', 'Functional', 'Permanent', 'Daily', 'Considered', 'Understated'].map((w) => (
                  <li
                    key={w}
                    className="py-3 border-b border-[var(--color-text-on-dark)]/10 text-[16px] font-light text-[var(--color-text-on-dark)] last:border-0"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="kvrn-label text-[var(--color-text-on-dark)]/30 mb-6">KVRN is not</p>
              <ul className="space-y-0">
                {['Fast fashion', 'Streetwear', 'Athleisure', 'Hype-driven', 'Seasonal', 'Promotional', 'Loud', 'Trend-referencing'].map((w) => (
                  <li
                    key={w}
                    className="py-3 border-b border-[var(--color-text-on-dark)]/10 text-[16px] font-light text-[var(--color-text-on-dark)]/30 last:border-0"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="section-y" aria-labelledby="cta-heading">
        <div className="kvrn-container text-center">
          <h2
            id="cta-heading"
            className="text-[clamp(32px,5vw,64px)] font-light leading-none tracking-tight mb-8"
          >
            The collection
            <br />
            is available now.
          </h2>
          <Link
            href="/shop"
            className="inline-flex items-center h-12 px-10 border border-[var(--color-text)] text-[11px] font-light tracking-[0.14em] uppercase hover:bg-[var(--color-text)] hover:text-[var(--color-bg)] transition-all duration-200"
          >
            Shop the collection
          </Link>
        </div>
      </section>
    </div>
  )
}
