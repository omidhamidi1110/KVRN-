import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title:       'Size Guide — KVRN',
  description: 'KVRN size guide and measurement tables for heavyweight hoodies and sweatpants.',
}

const hoodieRows = [
  { size: 'XS',  chest: 60, length: 72, sleeve: 63, shoulder: 52 },
  { size: 'S',   chest: 64, length: 74, sleeve: 64, shoulder: 54 },
  { size: 'M',   chest: 68, length: 76, sleeve: 65, shoulder: 56 },
  { size: 'L',   chest: 72, length: 78, sleeve: 66, shoulder: 58 },
  { size: 'XL',  chest: 76, length: 80, sleeve: 67, shoulder: 60 },
  { size: 'XXL', chest: 80, length: 82, sleeve: 68, shoulder: 62 },
]

const sweatpantsRows = [
  { size: 'XS',  waist: 64, hip: 90,  inseam: 74, leg: 22 },
  { size: 'S',   waist: 68, hip: 94,  inseam: 75, leg: 23 },
  { size: 'M',   waist: 72, hip: 98,  inseam: 76, leg: 24 },
  { size: 'L',   waist: 76, hip: 102, inseam: 77, leg: 24 },
  { size: 'XL',  waist: 80, hip: 106, inseam: 78, leg: 25 },
  { size: 'XXL', waist: 86, hip: 112, inseam: 79, leg: 26 },
]

export default function SizeGuidePage() {
  return (
    <div className="pt-[56px]" id="size-guide">
      <div className="container-kvrn section-padding max-w-3xl">
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li><Link href="/support/faq" className="hover:text-kvrn-text transition-colors">Support</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Size Guide</li>
          </ol>
        </nav>

        <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter mb-6">
          Size Guide
        </h1>

        {/* Fit overview */}
        <div className="border border-kvrn-border p-5 md:p-7 mb-14 bg-kvrn-bg-raised">
          <p className="label-11 mb-3">How KVRN fits</p>
          <p className="text-[14px] text-kvrn-muted leading-relaxed mb-3">
            KVRN is designed to be oversized. The silhouette is deliberate — wide through the
            chest and shoulders, long in the body, with a structured hood that sits high.
          </p>
          <ul className="space-y-2 text-[14px] text-kvrn-muted">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-kvrn-muted" aria-hidden="true" />
              <span><strong className="font-light text-kvrn-text">Intended fit:</strong> Buy your normal size for the full oversized silhouette.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-kvrn-muted" aria-hidden="true" />
              <span><strong className="font-light text-kvrn-text">Cleaner look:</strong> Size down one for a slightly more structured oversized shape.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-kvrn-muted" aria-hidden="true" />
              <span><strong className="font-light text-kvrn-text">Between sizes:</strong> Size down.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-kvrn-muted" aria-hidden="true" />
              <span><strong className="font-light text-kvrn-text">Unsure?</strong> Email <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2">hello@kvrn.com</a> with your height and usual size — we'll advise directly.</span>
            </li>
          </ul>
        </div>

        {/* How to measure */}
        <section className="mb-14" aria-labelledby="measure-heading">
          <h2 id="measure-heading" className="label-11 mb-6">How to measure</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {[
              {
                label: 'Chest',
                desc:  'Measure around the fullest part of your chest, keeping the tape parallel to the floor. Add 6–10cm for our intended oversized fit.',
              },
              {
                label: 'Body length',
                desc:  'Measured from the centre back neck point to the finished hem. All measurements are taken flat on the garment.',
              },
              {
                label: 'Sleeve',
                desc:  'Measured from the top of the shoulder seam to the finished cuff, with the arm extended flat.',
              },
              {
                label: 'Waist (sweatpants)',
                desc:  'Measured flat across the waistband × 2. The elastic waistband stretches — these measurements reflect the relaxed state.',
              },
            ].map((item) => (
              <div key={item.label} className="border-l-2 border-kvrn-border pl-4">
                <p className="text-[13px] font-light text-kvrn-text mb-1">{item.label}</p>
                <p className="text-[13px] text-kvrn-muted leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-kvrn-muted mt-4">
            All measurements in centimetres, taken flat. Manufacturing tolerance: ±1.5cm.
          </p>
        </section>

        {/* Hoodie table */}
        <section className="mb-14" aria-labelledby="hoodie-table-heading">
          <h2 id="hoodie-table-heading" className="label-11 mb-6">
            KVRN Heavyweight Hoodie — Garment Measurements (cm)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" aria-label="Hoodie size measurements">
              <thead>
                <tr className="border-b border-kvrn-border">
                  {['Size', 'Chest', 'Body length', 'Sleeve', 'Shoulder'].map((h) => (
                    <th key={h} className="text-left py-3 pr-6 font-light label-11">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-kvrn-border">
                {hoodieRows.map((row) => (
                  <tr key={row.size} className="hover:bg-kvrn-bg-raised transition-colors">
                    <td className="py-3 pr-6 font-light text-kvrn-text">{row.size}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.chest}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.length}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.sleeve}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.shoulder}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link
            href="/products/kvrn-heavyweight-hoodie"
            className="inline-block mt-5 text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2"
          >
            Shop the Hoodie →
          </Link>
        </section>

        {/* Sweatpants table */}
        <section className="mb-14" aria-labelledby="sweatpants-table-heading">
          <h2 id="sweatpants-table-heading" className="label-11 mb-6">
            KVRN Heavyweight Sweatpants — Garment Measurements (cm)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" aria-label="Sweatpants size measurements">
              <thead>
                <tr className="border-b border-kvrn-border">
                  {['Size', 'Waist (relaxed)', 'Hip', 'Inseam', 'Leg opening'].map((h) => (
                    <th key={h} className="text-left py-3 pr-6 font-light label-11">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-kvrn-border">
                {sweatpantsRows.map((row) => (
                  <tr key={row.size} className="hover:bg-kvrn-bg-raised transition-colors">
                    <td className="py-3 pr-6 font-light text-kvrn-text">{row.size}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.waist}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.hip}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.inseam}</td>
                    <td className="py-3 pr-6 text-kvrn-muted">{row.leg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link
            href="/products/kvrn-heavyweight-sweatpants"
            className="inline-block mt-5 text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2"
          >
            Shop the Sweatpants →
          </Link>
        </section>

        {/* Still unsure */}
        <section className="border-t border-kvrn-border pt-10">
          <p className="text-[15px] font-light mb-2">Still unsure?</p>
          <p className="text-[14px] text-kvrn-muted mb-4">
            Email us your height and usual hoodie size. We'll tell you exactly which size to order.
          </p>
          <a
            href="mailto:hello@kvrn.com?subject=Sizing question"
            className="text-[13px] font-light tracking-widest uppercase border border-kvrn-text px-5 h-10 inline-flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
          >
            Email us
          </a>
        </section>
      </div>
    </div>
  )
}
