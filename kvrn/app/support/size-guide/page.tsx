import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Size Guide — KVRN',
  description: 'KVRN size guide. Hoodie and sweatpants measurements in centimetres.',
}

// Measurements from the official KVRN size charts (cm)
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

export default function SizeGuidePage() {
  return (
    <div className="pt-[calc(36px+56px)]">
      <div className="container-kvrn section-padding max-w-3xl">

        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-[#9B9B9B]">
            <li><Link href="/" className="hover:text-[#1A1A1A] transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-[#1A1A1A]" aria-current="page">Size Guide</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-[-0.03em] mb-4">
          Size Guide
        </h1>
        <p className="text-[14px] text-[#6B6B6B] mb-14 leading-relaxed">
          All measurements are in centimetres and refer to garment dimensions, not body measurements.
          KVRN is designed oversized. Buy your normal size for the full silhouette, or size down for a slightly more fitted oversized shape.
        </p>

        {/* Hoodie */}
        <section className="mb-14" aria-labelledby="hoodie-size-h">
          <div className="flex items-baseline justify-between mb-5">
            <h2 id="hoodie-size-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              Hoodie — Size Chart (cm)
            </h2>
            <Link href="/shop?type=hoodies"
              className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
              Shop Hoodies
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" aria-label="Hoodie size chart in centimetres">
              <thead>
                <tr className="border-b border-[#E8E5E0]">
                  {['Size (cm)', 'Length', 'Chest', 'Shoulder Width', 'Sleeve Length'].map(h => (
                    <th key={h} className="text-left py-3 pr-6 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B] first:pr-8">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HOODIE_ROWS.map((row, i) => (
                  <tr key={row.size} className={`border-b border-[#E8E5E0] ${i % 2 === 0 ? '' : 'bg-[#F9F8F6]'}`}>
                    <td className="py-3 pr-8 font-light text-[#1A1A1A]">{row.size}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{row.length}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{row.chest}</td>
                    <td className="py-3 pr-6 text-[#6B6B6B]">{row.shoulder}</td>
                    <td className="py-3 text-[#6B6B6B]">{row.sleeve}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 space-y-2 text-[12px] text-[#9B9B9B]">
            <p>Chest: measured flat across the chest under the arms.</p>
            <p>Length: measured from highest point of shoulder to hem.</p>
            <p>Shoulder width: measured straight across the back between shoulder seams.</p>
            <p>Sleeve length: measured from shoulder seam to cuff.</p>
          </div>
        </section>

        {/* Sweatpants */}
        <section className="mb-14" aria-labelledby="pants-size-h">
          <div className="flex items-baseline justify-between mb-5">
            <h2 id="pants-size-h" className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              Sweatpants — Size Chart (cm)
            </h2>
            <Link href="/shop?type=sweatpants"
              className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
              Shop Sweatpants
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" aria-label="Sweatpants size chart in centimetres">
              <thead>
                <tr className="border-b border-[#E8E5E0]">
                  {['Size (cm)', 'Waist', 'Hip', 'Length'].map(h => (
                    <th key={h} className="text-left py-3 pr-8 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PANTS_ROWS.map((row, i) => (
                  <tr key={row.size} className={`border-b border-[#E8E5E0] ${i % 2 === 0 ? '' : 'bg-[#F9F8F6]'}`}>
                    <td className="py-3 pr-8 font-light text-[#1A1A1A]">{row.size}</td>
                    <td className="py-3 pr-8 text-[#6B6B6B]">{row.waist}</td>
                    <td className="py-3 pr-8 text-[#6B6B6B]">{row.hip}</td>
                    <td className="py-3 text-[#6B6B6B]">{row.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 space-y-2 text-[12px] text-[#9B9B9B]">
            <p>Waist: measured flat across the waistband (x2 for full circumference).</p>
            <p>Hip: measured at the widest point of the leg, flat (x2 for full circumference).</p>
            <p>Length: measured from the waistband to the hem along the outseam.</p>
          </div>
        </section>

        <div className="border-t border-[#E8E5E0] pt-8 space-y-3 text-[13px] text-[#6B6B6B]">
          <p>
            Available sizes: XS through XXL. 3XL available on request — contact{' '}
            <a href="mailto:support@kvrn.shop" className="text-[#1A1A1A] underline underline-offset-2">
              support@kvrn.shop
            </a>.
          </p>
          <p>
            If you are between sizes, we recommend sizing down for a cleaner silhouette.
          </p>
        </div>
      </div>
    </div>
  )
}
