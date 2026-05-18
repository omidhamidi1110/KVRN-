import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'About — KVRN',
  description: 'KVRN. Quiet luxury meets premium utility. Why we exist and what we stand for.',
}

export default function AboutPage() {
  return (
    <div className="pt-[calc(36px+56px)]">

      {/* Hero */}
      <section className="section-padding bg-[#0E0E0E] text-[#F0EDE8]" aria-labelledby="about-hero">
        <div className="container-kvrn max-w-4xl">
          <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/40 mb-10">KVRN</p>
          <h1 id="about-hero"
            className="font-display font-light text-[clamp(44px,7vw,88px)] leading-none tracking-[-0.03em] mb-12">
            Silence.<br />Weight.<br />Presence.
          </h1>
          <p className="text-[17px] md:text-[20px] font-light text-[#F0EDE8]/60 leading-relaxed max-w-[520px]">
            KVRN exists because most clothing that calls itself premium is not.
            The fabric is ordinary. The branding does the work the garment cannot.
          </p>
        </div>
      </section>

      {/* The problem */}
      <section className="section-padding border-b border-[#E8E5E0]" aria-labelledby="problem-h">
        <div className="container-kvrn">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-16">
            <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]" id="problem-h">
              The problem
            </p>
            <div className="space-y-5 text-[16px] font-light text-[#6B6B6B] leading-relaxed max-w-[600px]">
              <p>
                Products are marketed as premium when they are not.
                Weight claims are inflated. Construction is compromised to hit price points.
                Branding is applied where quality should speak.
              </p>
              <p>
                We decided not to make those compromises.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The standard */}
      <section className="section-padding border-b border-[#E8E5E0]" aria-labelledby="standard-h">
        <div className="container-kvrn">
          <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-12" id="standard-h">
            The standard
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-[#E8E5E0]">
            {[
              {
                heading: 'The weight.',
                body: 'Every piece is built around genuine heavyweight fabric. Dense enough to hold structure, heavy enough to feel considered. Full specifications on each product page.',
              },
              {
                heading: 'The construction.',
                body: 'Details that exist because they solve a problem, not because they photograph well. Function is the standard. Anything that does not serve a purpose is removed.',
              },
              {
                heading: 'The utility.',
                body: 'Practical features built into the design from the start, not added as afterthoughts. Products built for daily wear, not occasional use.',
              },
              {
                heading: 'The finish.',
                body: 'Minimal branding. The garment is the statement. Identifying marks are present where appropriate and absent where they are not needed.',
              },
            ].map(item => (
              <div key={item.heading} className="bg-[#F9F8F6] px-8 py-10">
                <p className="text-[15px] font-light mb-4">{item.heading}</p>
                <p className="text-[13px] font-light text-[#6B6B6B] leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What KVRN is / is not */}
      <section className="section-padding bg-[#0E0E0E] text-[#F0EDE8]" aria-labelledby="position-h">
        <div className="container-kvrn">
          <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/40 mb-12" id="position-h">
            The position
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-16 max-w-3xl">
            <div>
              <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/60 mb-6">KVRN is</p>
              <ul>
                {['Architectural', 'Heavyweight', 'Minimal', 'Functional', 'Permanent', 'Daily wear', 'Considered', 'Understated'].map(w => (
                  <li key={w} className="py-3 border-b border-[#F0EDE8]/10 text-[16px] font-light text-[#F0EDE8] last:border-0">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/30 mb-6">KVRN is not</p>
              <ul>
                {['Fast fashion', 'Streetwear', 'Athleisure', 'Hype-driven', 'Seasonal', 'Promotional', 'Loud', 'Trend-referencing'].map(w => (
                  <li key={w} className="py-3 border-b border-[#F0EDE8]/10 text-[16px] font-light text-[#F0EDE8]/30 last:border-0">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section-padding" aria-labelledby="cta-h">
        <div className="container-kvrn text-center">
          <h2 id="cta-h"
            className="font-display font-light text-[clamp(32px,5vw,60px)] leading-none tracking-tight mb-8">
            The collection is available now.
          </h2>
          <Link href="/shop"
            className="inline-flex items-center h-12 px-10 border border-[#1A1A1A] text-[11px] font-light tracking-[0.14em] uppercase hover:bg-[#1A1A1A] hover:text-[#F9F8F6] transition-all duration-200">
            Shop the collection
          </Link>
        </div>
      </section>
    </div>
  )
}
