import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'About — KVRN',
  description: 'KVRN is built around weight, structure, and restraint. Quiet garments designed for daily wear.',
}

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      {/* Dark intro */}
      <PageHero title="About" breadcrumb="About" />

      {/* Content */}
      <div className="container-kvrn max-w-3xl py-16 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-16">
          <div className="space-y-6">
            <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">The brand</p>
            <p className="text-[16px] font-light text-[#1A1A1A] leading-relaxed">
              KVRN is built around weight, structure, and restraint.
            </p>
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">
              Every piece starts from the fabric — not from a trend. We work with fleece heavy enough to hold its shape,
              cut to proportions that make sense without needing to be adjusted.
            </p>
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">
              There is no branding on the outside. No drawstrings to pull. No visible hardware unless it serves a purpose.
              The goal is a garment you stop thinking about because it works.
            </p>
          </div>
          <div className="space-y-6">
            <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">The approach</p>
            <div className="space-y-4">
              {[
                ['Weight',      'Dense enough to feel structural. GSM is a starting point, not a selling point.'],
                ['Construction','Every detail serves a purpose. What you see is what it does.'],
                ['Longevity',   'Built to be worn daily without showing it. No decoration that fades.'],
                ['Restraint',   'Nothing added that should not be there.'],
              ].map(([title, desc]) => (
                <div key={title} className="pb-4 border-b border-[#E8E5E0] last:border-0 last:pb-0">
                  <p className="text-[13px] font-light text-[#1A1A1A] mb-1">{title}</p>
                  <p className="text-[13px] text-[#6B6B6B] leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-16 pt-10 border-t border-[#E8E5E0]">
          <Link href="/shop"
            className="inline-flex items-center h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300">
            Shop the collection
          </Link>
        </div>
      </div>
    </div>
  )
}
