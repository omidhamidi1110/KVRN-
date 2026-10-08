'use client'

// Product grid for an Admin-managed collection. Shows the collection's translated description
// (client picks the visitor's language) and the ordered products. Products that exist in the
// coded catalog use the standard ProductCard; others get a minimal link card.
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { ProductCard } from '@/components/product/ProductCard'
import { getProductBySlug } from '@/data/products'
import { useCurrency } from '@/context/CurrencyContext'
import { LOCALES, isLocale } from '@/lib/i18n/locales'

const CODE_TO_PUBLIC_SLUG: Record<string, string> = { PKHH: 'kvrn-phantom-hoodie', PKHSP: 'kvrn-phantom-sweatpants' }

interface Props {
  text: Record<string, { name: string; description: string }>
  products: Array<{ id: string; name: string; slug: string; productCode: string; priceCents: number; currency: string }>
}

export function CollectionGrid({ text, products }: Props) {
  const { locale } = useI18n()
  const { formatPrice } = useCurrency()
  const t = text[locale] ?? text.en
  return (
    <div lang={text[locale] ? locale : 'en'} dir={text[locale] && isLocale(locale) && LOCALES[locale].rtl ? 'rtl' : undefined}>
      {t.description && <p className="text-[14px] text-[#6B6B6B] leading-relaxed max-w-[560px] mb-10 whitespace-pre-line">{t.description}</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-6">
        {products.map(p => {
          const coded = getProductBySlug(CODE_TO_PUBLIC_SLUG[p.productCode] ?? p.slug)
          if (coded) return <ProductCard key={p.id} product={coded} />
          return (
            <Link key={p.id} href={`/products/${p.slug}`} className="block border border-[#E8E5E0] p-4 hover:border-[#1A1A1A] transition-colors">
              <p className="text-[13px] font-light text-[#1A1A1A]">{p.name}</p>
              <p className="text-[12px] text-[#6B6B6B] mt-1">{formatPrice(p.priceCents)}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
