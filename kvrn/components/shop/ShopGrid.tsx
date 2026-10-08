'use client'

// ShopGrid — the Admin-managed product listing shown under the collection hero when the
// CMS product catalog is serving the storefront (flag CMS_PRODUCT_ROUTING ON). Prices are the
// canonical cents formatted by lib/product-price. Cards link to the product page, which is the
// purchase path (live availability is verified there), so no stock claim is made here.
import Link from 'next/link'
import Image from 'next/image'
import type { Product } from '@/types'
import { formatProductPrice } from '@/lib/product-price'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'

export function ShopGrid({ products, heading }: { products: Product[]; heading?: string }) {
  const { formatPrice, isEstimate } = useCurrency()
  const t = fillMessages(useI18n().t)
  // USD keeps the exact canonical format ($80 / $79.50); a non-USD choice is a labelled estimate.
  const money = (cents: number) => isEstimate ? formatPrice(cents) : formatProductPrice(cents)
  if (!products.length) return null
  return (
    <section aria-label={heading ?? t['shop.productsLabel']} style={{ background: '#F9F8F6' }}>
      <div style={{ maxWidth: 1380, margin: '0 auto', padding: '64px 28px' }}>
        {heading && (
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 300, fontSize: 'clamp(24px,2.4vw,32px)',
                       letterSpacing: '-0.025em', color: '#1A1A1A', marginBottom: 32 }}>{heading}</h2>
        )}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 24,
                     gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {products.map((p, i) => {
            const img = p.colors[0]?.images.find(x => x.type === 'front') ?? p.colors[0]?.images[0]
            return (
              <li key={p.slug}>
                <Link href={`/products/${p.slug}`} aria-label={`${p.name} — ${money(p.price)}`}
                  style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ position: 'relative', aspectRatio: '3/4', background: '#F0EDE8', overflow: 'hidden', marginBottom: 12 }}>
                    {img?.src && (
                      <Image src={img.src} alt={img.alt || p.name} fill priority={i < 2}
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        style={{ objectFit: 'cover', objectPosition: img.focalDesktop ? `${img.focalDesktop.x * 100}% ${img.focalDesktop.y * 100}%` : 'center top' }} />
                    )}
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 300, color: '#1A1A1A', margin: '0 0 4px', lineHeight: 1.3 }}>{p.name}</p>
                  <p style={{ fontSize: 13, fontWeight: 300, color: '#9B9B9B', margin: 0, fontVariantNumeric: 'tabular-nums' }}>{money(p.price)}</p>
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
