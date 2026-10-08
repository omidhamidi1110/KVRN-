'use client'

import { CollectionHero } from '@/components/shop/CollectionHero'
import { ShopGrid } from '@/components/shop/ShopGrid'
import { formatProductPrice } from '@/lib/product-price'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'
import type { Product } from '@/types'

// `listing` is passed ONLY when the Admin-managed catalog is serving the shop (flag
// CMS_PRODUCT_ROUTING ON). Without it this renders exactly as the coded shop always has.
interface Props { products: Product[]; type: string | null; headingOverride?: string; listing?: Product[] }

export function ShopClient({ products, type, listing }: Props) {
  const t = fillMessages(useI18n().t)
  if (!listing) return <CodedHero type={type} />
  return (
    <>
      <CodedHero type={type} listing={listing} />
      <ShopGrid products={listing} heading={type === 'hoodies' ? t.hoodies : type === 'sweatpants' ? t.sweatpants : t['shop.allProducts']} />
    </>
  )
}

function CodedHero({ type, listing }: { type: string | null; listing?: Product[] }) {
  const t = fillMessages(useI18n().t)
  const { formatPrice, isEstimate } = useCurrency()
  // USD keeps the canonical format ($80 / $79.50); a non-USD choice is a labelled estimate.
  const money = (cents: number) => isEstimate ? formatPrice(cents) : formatProductPrice(cents)
  const fabric = [t['shop.specFabric1'], t['shop.specFabric2'], t['shop.specFabric3']]
  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'
  // Hero links show the canonical price of the live product, and only link to products that are live.
  const priceOf = (slug: string) => {
    if (!listing) return money(8000)
    const p = listing.find(x => x.slug === slug)
    return p ? money(p.price) : ''
  }
  const live = (slug: string) => !listing || listing.some(x => x.slug === slug)

  if (isHoodies) {
    return (
      <CollectionHero
        desktopImage="/images/collections/hoodies-desktop-hero-no-text.jpeg"
        desktopAlt={t['shop.hoodies.alt']}
        mobileImage="/images/collections/hoodies-mobile-hero.png"
        mobileAlt={t['shop.hoodies.alt']}
        eyebrow1="PROJECT KVRN"
        eyebrow2={t['shop.drop001']}
        headlineLines={[t['shop.hoodies.line1'], t['shop.hoodies.line2']]}
        specs1={fabric}
        specs2={[t['shop.hoodies.spec1'], t['shop.hoodies.spec2'], t['shop.hoodies.spec3']]}
        desktopLink={live('kvrn-phantom-hoodie') ? {
          name:t['shop.heavyweightHoodie'], price:priceOf('kvrn-phantom-hoodie'),
          href:'/products/kvrn-phantom-hoodie',
          desktopStyle:{ top:'86%', right:'clamp(34px,3.8vw,58px)', width:'clamp(175px,13.5vw,205px)' },
        } : undefined}
        mobileLinks={live('kvrn-phantom-hoodie') ? [{
          name:t['shop.heavyweightHoodie'], price:priceOf('kvrn-phantom-hoodie'),
          href:'/products/kvrn-phantom-hoodie',
          desktopStyle:{},
        }] : []}
      />
    )
  }

  if (isSweatpants) {
    return (
      <CollectionHero
        desktopImage="/images/collections/sweatpants-desktop-hero.png"
        desktopAlt={t['shop.sweatpants.alt']}
        mobileImage="/images/collections/sweatpants-mobile-hero.png"
        mobileAlt={t['shop.sweatpants.alt']}
        eyebrow1="PROJECT KVRN"
        eyebrow2={t['shop.drop001']}
        headlineLines={[t['shop.sweatpants.line1'], t['shop.sweatpants.line2']]}
        specs1={fabric}
        specs2={[t['shop.sweatpants.spec1'], t['shop.sweatpants.spec2'], t['shop.sweatpants.spec3']]}
        desktopLink={live('kvrn-phantom-sweatpants') ? {
          name:t['shop.heavyweightSweatpants'], price:priceOf('kvrn-phantom-sweatpants'),
          href:'/products/kvrn-phantom-sweatpants',
          desktopStyle:{ top:'61%', right:'clamp(22px,2.2vw,34px)', width:'clamp(190px,14.5vw,215px)' },
        } : undefined}
        mobileLinks={live('kvrn-phantom-sweatpants') ? [{
          name:t['shop.heavyweightSweatpants'], price:priceOf('kvrn-phantom-sweatpants'),
          href:'/products/kvrn-phantom-sweatpants',
          desktopStyle:{},
        }] : []}
      />
    )
  }

  // Shop All
  return (
    <CollectionHero
      desktopImage="/images/collections/shop-all-desktop-hero.png"
      desktopAlt={t['shop.all.alt']}
      mobileImage="/images/collections/shop-all-mobile-hero.png"
      mobileAlt={t['shop.all.alt']}
      eyebrow1="PROJECT KVRN"
      eyebrow2={t['shop.drop001']}
      headlineLines={[t['shop.all.line1'], t['shop.all.line2']]}
      specs1={fabric}
      specs2={[t['shop.all.spec1'], t['shop.all.spec2'], t['shop.all.spec3']]}
      productLinks={[
        {
          name: t['shop.heavyweightHoodie'],
          price: priceOf('kvrn-phantom-hoodie'),
          href: '/products/kvrn-phantom-hoodie',
          desktopStyle: { right: 'clamp(48px,7vw,120px)', top: '24%' },
          slug: 'kvrn-phantom-hoodie',
        },
        {
          name: t['shop.heavyweightSweatpants'],
          price: priceOf('kvrn-phantom-sweatpants'),
          href: '/products/kvrn-phantom-sweatpants',
          desktopStyle: { right: 'clamp(48px,7vw,120px)', top: '62%' },
          slug: 'kvrn-phantom-sweatpants',
        },
      ].filter(l => live(l.slug)).map(({ slug: _s, ...l }) => l)}
      mobileLinks={[
        { name:t['shop.heavyweightHoodie'], price:priceOf('kvrn-phantom-hoodie'), href:'/products/kvrn-phantom-hoodie', desktopStyle:{}, slug: 'kvrn-phantom-hoodie' },
        { name:t['shop.heavyweightSweatpants'], price:priceOf('kvrn-phantom-sweatpants'), href:'/products/kvrn-phantom-sweatpants', desktopStyle:{}, slug: 'kvrn-phantom-sweatpants' },
      ].filter(l => live(l.slug)).map(({ slug: _s, ...l }) => l)}
    />
  )
}
