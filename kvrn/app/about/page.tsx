import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'

export const metadata: Metadata = {
  title: 'About — KVRN',
  description:
    'KVRN. Quiet luxury meets premium utility. 400 GSM+ heavyweight fleece built for daily wear.',
}

export default function AboutPage() {
  return (
    <div className="pt-[56px]">
      {/* ─── Hero ─── */}
      <section className="section-padding border-b border-kvrn-border">
        <div className="container-kvrn max-w-3xl">
          <p className="label-11 mb-8">About</p>
          <h1 className="font-display font-light text-[48px] md:text-[72px] leading-none tracking-tighter mb-10">
            Quiet luxury.
            <br />
            Premium utility.
          </h1>
          <p className="text-[17px] md:text-[20px] font-light text-kvrn-muted leading-relaxed max-w-[560px]">
            KVRN makes one thing: heavyweight oversized hoodies and sweatpants.
            We make them as well as they can be made.
          </p>
        </div>
      </section>

      {/* ─── Story ─── */}
      <section className="section-padding border-b border-kvrn-border">
        <div className="container-kvrn">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-24">
            <div>
              <p className="label-11 mb-6">The story</p>
              <div className="space-y-5 text-[15px] text-kvrn-muted leading-relaxed">
                <p>
                  Most heavyweight hoodies are not heavyweight. They are called heavyweight
                  because there is no agreed standard, and the word sells.
                </p>
                <p>
                  300 GSM is common. 320 GSM is marketed as heavy. 350 GSM is sold as
                  premium. KVRN starts at 400 GSM. That is where the weight becomes
                  structural — where the hood holds its form, where the fabric
                  drapes rather than hangs, where you feel the quality the moment
                  you lift it.
                </p>
                <p>
                  The 3-panel hood exists because a single-panel hood collapses. The
                  interior zippers exist because a pocket should be secure. The absence
                  of a drawstring exists because the hood was engineered not to need one.
                </p>
                <p>
                  None of this is visible from the outside. That is the point.
                </p>
              </div>
            </div>

            <div>
              <p className="label-11 mb-6">The standard</p>
              <ul className="space-y-6">
                {[
                  {
                    title: 'Tested per batch.',
                    body:  'Every production batch is weight-tested. Our 400 GSM claim is verified, not assumed. The minimum we accept is 390 GSM.',
                  },
                  {
                    title: 'Single supplier.',
                    body:  'We work with one manufacturer. We know their process. We have approved their sample at every production stage.',
                  },
                  {
                    title: 'No visible branding.',
                    body:  'A single rubber patch on the hood exterior. No logos on chest, sleeve, or hem. The garment speaks for itself.',
                  },
                  {
                    title: 'Permanent design.',
                    body:  'KVRN is not seasonal. The hoodie and sweatpants are not updated each year. We refine the construction. We never chase trends.',
                  },
                ].map((item) => (
                  <li key={item.title} className="pb-6 border-b border-kvrn-border last:border-0 last:pb-0">
                    <p className="text-[14px] font-light mb-2">{item.title}</p>
                    <p className="text-[14px] text-kvrn-muted leading-relaxed">{item.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Construction image spread ─── */}
      <section className="section-padding border-b border-kvrn-border bg-kvrn-bg-raised">
        <div className="container-kvrn">
          <p className="label-11 mb-10 md:mb-14">The construction</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
            {[
              { label: 'Hood structure',    img: '/images/construction/hood-structure.webp' },
              { label: 'Interior zippers',  img: '/images/construction/interior-zippers.webp' },
              { label: 'Fabric weight',     img: '/images/construction/fabric-weight.webp' },
              { label: '3-panel seam',      img: '/images/construction/panel-seam.webp' },
              { label: 'Stitch detail',     img: '/images/construction/stitch-detail.webp' },
              { label: 'KVRN patch',        img: '/images/construction/kvrn-patch.webp' },
            ].map((item) => (
              <figure key={item.label} className="space-y-2">
                <div className="relative aspect-square bg-kvrn-bg overflow-hidden">
                  <Image
                    src={item.img}
                    alt={`KVRN ${item.label} — construction detail`}
                    fill
                    className="object-cover"
                    sizes="(max-width: 768px) 50vw, 33vw"
                  />
                  {/* Placeholder */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <p className="label-11 text-kvrn-subtle text-center px-3">{item.label}</p>
                  </div>
                </div>
                <figcaption className="label-11 text-kvrn-muted">{item.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ─── What KVRN is not ─── */}
      <section className="section-padding border-b border-kvrn-border">
        <div className="container-kvrn max-w-2xl">
          <p className="label-11 mb-8">The position</p>
          <div className="grid grid-cols-2 gap-x-12 gap-y-3">
            <div>
              <p className="label-11 mb-4 text-kvrn-text">KVRN is</p>
              {['Architectural', 'Minimal', 'Heavyweight', 'Permanent', 'Daily', 'Functional'].map((w) => (
                <p key={w} className="text-[15px] font-light py-2.5 border-b border-kvrn-border last:border-0">{w}</p>
              ))}
            </div>
            <div>
              <p className="label-11 mb-4 text-kvrn-muted">KVRN is not</p>
              {['Fast fashion', 'Streetwear', 'Gym brand', 'Seasonal', 'Branded', 'Promotional'].map((w) => (
                <p key={w} className="text-[15px] font-light text-kvrn-muted py-2.5 border-b border-kvrn-border last:border-0">{w}</p>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="section-padding">
        <div className="container-kvrn text-center">
          <p className="font-display font-light text-[32px] md:text-[48px] leading-none tracking-tighter mb-8">
            Drop 001 is available now.
          </p>
          <Link href="/shop">
            <Button variant="primary" size="lg">Shop the drop</Button>
          </Link>
        </div>
      </section>
    </div>
  )
}
