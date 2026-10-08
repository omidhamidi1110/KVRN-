'use client'

// Public size guide tables with the cm / in toggle (same behaviour as the coded page).
// Everything shown is data from Admin content; numeric cells are converted, text cells are not.

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useI18n, LocaleScope } from '@/context/I18nContext'
import { LOCALES, isLocale, SOURCE_LOCALE } from '@/lib/i18n/locales'
import { fillMessages, format } from '@/lib/i18n/messages'
import { convertCell } from '@/lib/content-size-guide'

export interface GuideVM {
  id: string
  name: string
  unit: 'cm' | 'in'
  rowHeader: string
  columns: Array<{ id: string; label: string }>
  rows: Array<{ id: string; label: string; values: Record<string, string> }>
  notes: string[]
  shopLink?: { label: string; href: string }
  image?: { url: string; alt: string }
  fit: ReactNode
}
export interface SizeGuideVM {
  intro: string
  guides: GuideVM[]
  tip: ReactNode
  links: Array<{ id: string; label: string; href: string }>
}

export function SizeGuideClient({ variants }: { variants: Record<string, SizeGuideVM> }) {
  const { locale, t: dict } = useI18n()
  const t = fillMessages(dict)
  const [inches, setInches] = useState(false)
  const key = variants[locale] ? locale : 'en'
  const vm = variants[key]
  if (!vm) return null
  const scope = isLocale(key) ? key : SOURCE_LOCALE
  const fellBack = key !== locale
  return (
    <LocaleScope locale={scope}>
    <div lang={key} dir={LOCALES[scope].rtl ? 'rtl' : undefined}>
      {vm.intro && (
        <p className="text-[14px] text-[#6B6B6B] mb-8 leading-relaxed max-w-[540px]">{vm.intro}</p>
      )}
      <div className="flex gap-1 mb-10" role="group" aria-label={t['sizeGuide.units']}>
        {(['cm', 'in'] as const).map(u => (
          <button key={u} type="button" onClick={() => setInches(u === 'in')} aria-pressed={(u === 'in') === inches}
            className={`h-8 px-4 text-[11px] tracking-[0.1em] uppercase border transition-colors ${((u === 'in') === inches) ? 'border-[#1A1A1A] text-[#1A1A1A]' : 'border-[#E8E5E0] text-[#9B9B9B] hover:text-[#1A1A1A]'}`}>
            {u}
          </button>
        ))}
      </div>

      {vm.guides.map(g => (
        <section key={g.id} className="mb-14" aria-labelledby={`${g.id}-size-h`}>
          <div className="flex items-baseline justify-between mb-5">
            <h2 id={`${g.id}-size-h`} className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">{g.name}</h2>
            {g.shopLink && (
              <Link href={g.shopLink.href}
                className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
                {g.shopLink.label}
              </Link>
            )}
          </div>
          {g.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={g.image.url} alt={g.image.alt} loading="lazy" className="w-full h-auto mb-6" />
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" aria-label={format(t['sizeGuide.chartLabel'], { name: g.name })}>
              <thead>
                <tr className="border-b border-[#E8E5E0]">
                  <th scope="col" className="text-start py-3 pe-8 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B]">{g.rowHeader}</th>
                  {g.columns.map(c => (
                    <th key={c.id} scope="col" className="text-start py-3 pe-6 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B]">
                      {c.label} ({inches ? 'in' : 'cm'})
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r, i) => (
                  <tr key={r.id} className={`border-b border-[#E8E5E0] ${i % 2 === 1 ? 'bg-[#F9F8F6]' : ''}`}>
                    <td className="py-3 pe-8 font-light text-[#1A1A1A]">{r.label}</td>
                    {g.columns.map(c => (
                      <td key={c.id} className="py-3 pe-6 text-[#6B6B6B]">{convertCell(r.values[c.id] ?? '', g.unit, inches)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {g.notes.length > 0 && (
            <div className="mt-5 space-y-1.5 text-[12px] text-[#9B9B9B]">
              {g.notes.map((n, i) => <p key={i}>{n}</p>)}
            </div>
          )}
          {g.fit && <div className="mt-5">{g.fit}</div>}
        </section>
      ))}

      {(vm.tip || vm.links.length > 0) && (
        <div className="border-t border-[#E8E5E0] pt-8 space-y-4">
          {vm.tip}
          {vm.links.length > 0 && (
            <div className="flex gap-5">
              {vm.links.map(l => (
                <Link key={l.id} href={l.href}
                  className="text-[13px] text-[#1A1A1A] underline underline-offset-2 hover:text-[#6B6B6B] transition-colors">
                  {l.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {fellBack && <p lang={locale} role="note" className="mt-8 text-[12px] text-[#9B9B9B]">{t['content.englishOnly']}</p>}
    </div>
    </LocaleScope>
  )
}
