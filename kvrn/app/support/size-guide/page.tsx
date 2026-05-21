'use client'

import { PageHero } from '@/components/layout/PageHero'
import { useState } from 'react'
import Link from 'next/link'

// Measurements in cm — converted to inches on toggle
const HOODIE_ROWS = [
  { size: 'XS',  length: 62,   chest: 62,   shoulder: 64,   sleeve: 52 },
  { size: 'S',   length: 65,   chest: 65,   shoulder: 67,   sleeve: 55 },
  { size: 'M',   length: 68,   chest: 68,   shoulder: 70,   sleeve: 58 },
  { size: 'L',   length: 70.5, chest: 70.5, shoulder: 72.5, sleeve: 60.5 },
  { size: 'XL',  length: 73,   chest: 73,   shoulder: 75,   sleeve: 63 },
  { size: '2XL', length: 75.5, chest: 75.5, shoulder: 77.5, sleeve: 65.5 },
  { size: '3XL', length: 78,   chest: 78,   shoulder: 80,   sleeve: 68 },
]

const PANTS_ROWS = [
  { size: 'XS',  waist: 66, hip: 112, length: 97 },
  { size: 'S',   waist: 70, hip: 114, length: 99 },
  { size: 'M',   waist: 74, hip: 116, length: 101 },
  { size: 'L',   waist: 78, hip: 118, length: 103 },
  { size: 'XL',  waist: 82, hip: 120, length: 105 },
  { size: '2XL', waist: 86, hip: 122, length: 107 },
  { size: '3XL', waist: 90, hip: 124, length: 109 },
]

function cm(val: number, useInches: boolean) {
  if (!useInches) return `${val}`
  return `${(val / 2.54).toFixed(1)}"`
}

export default function SizeGuidePage() {
  const [inches, setInches] = useState(false)

  return (
    <div className="pt-[calc(36px+56px)]">
      {/* Dark header */}
      <PageHero title="Size Guide" breadcrumb="Size Guide" />

      <div className="container-kvrn max-w-3xl py-12">
        <p className="text-[14px] text-[#6B6B6B] mb-12 leading-relaxed max-w-[540px]">
          All measurements refer to the garment, not body size. KVRN is designed oversized.
          Order your usual size for the intended silhouette. Size down if you prefer a slightly closer fit.
        </p>

        {/* Hoodie */}
        <section className="mb-14" aria-labelledby="hoodie-size-h">
          <div className="flex items-baseline justify-between mb-5">
            <h2 id="hoodie-size-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              Hoodie
            </h2>
            <Link href="/shop?type=hoodies"
              className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
              Shop Hoodies
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" aria-label="Hoodie size chart">
              <thead>
                <tr className="border-b border-[#E8E5E0]">
                  {['Size', 'Length', 'Chest', 'Shoulder', 'Sleeve'].map(h => (
                    <th key={h} className="text-left py-3 pr-6 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B] first:pr-8">
                      {h}{h !== 'Size' ? ` (${inches ? 'in' : 'cm'})` : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HOODIE_ROWS.map((row, i) => (
                  <tr key={row.size} className={`border-b border-[#E8E5E0] ${i % 2 === 1 ? 'bg-[#F9F8F6]' : ''}`}>
                    <td className="py-3 pr-8 font-light text-[#1A1A1A]">{row.size}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{cm(row.length, inches)}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{cm(row.chest, inches)}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{cm(row.shoulder, inches)}</td>
                    <td className="py-3 text-[#6B6B6B]">{cm(row.sleeve, inches)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 space-y-1.5 text-[12px] text-[#9B9B9B]">
            <p>Chest measured flat across the chest under the arms.</p>
            <p>Length from highest point of shoulder to hem.</p>
          </div>
        </section>

        {/* Sweatpants */}
        <section className="mb-12" aria-labelledby="pants-size-h">
          <div className="flex items-baseline justify-between mb-5">
            <h2 id="pants-size-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              Sweatpants
            </h2>
            <Link href="/shop?type=sweatpants"
              className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
              Shop Sweatpants
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" aria-label="Sweatpants size chart">
              <thead>
                <tr className="border-b border-[#E8E5E0]">
                  {['Size', 'Waist', 'Hip', 'Length'].map(h => (
                    <th key={h} className="text-left py-3 pr-6 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B] first:pr-8">
                      {h}{h !== 'Size' ? ` (${inches ? 'in' : 'cm'})` : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PANTS_ROWS.map((row, i) => (
                  <tr key={row.size} className={`border-b border-[#E8E5E0] ${i % 2 === 1 ? 'bg-[#F9F8F6]' : ''}`}>
                    <td className="py-3 pr-8 font-light text-[#1A1A1A]">{row.size}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{cm(row.waist, inches)}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{cm(row.hip, inches)}</td>
                    <td className="py-3 text-[#6B6B6B]">{cm(row.length, inches)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 space-y-1.5 text-[12px] text-[#9B9B9B]">
            <p>Waist measured flat across the waistband.</p>
            <p>Length measured from waistband to hem.</p>
          </div>
        </section>

        {/* Tip + links */}
        <div className="border-t border-[#E8E5E0] pt-8 space-y-4">
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed max-w-[500px]">
            If you are between sizes, we recommend sizing down for a cleaner oversized fit. Questions about fit can be sent to <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">support@kvrn.shop</a>.
          </p>
          <div className="flex gap-5">
            <Link href="/shop?type=hoodies"
              className="text-[13px] text-[#1A1A1A] underline underline-offset-2 hover:text-[#6B6B6B] transition-colors">
              Shop Hoodies
            </Link>
            <Link href="/shop?type=sweatpants"
              className="text-[13px] text-[#1A1A1A] underline underline-offset-2 hover:text-[#6B6B6B] transition-colors">
              Shop Sweatpants
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
