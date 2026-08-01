'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { ProductCard } from '@/components/product/ProductCard'
import { CollectionHero } from '@/components/shop/CollectionHero'
import type { Product } from '@/types'

// ─── Per-collection hero config ───────────────────────────────────────────────
const SHOP_ALL_DESKTOP_IMAGE   = '/images/collections/shop-all-desktop-hero.jpg'
const HOODIES_DESKTOP_IMAGE    = '/images/collections/hoodies-desktop-hero.jpg'
const SWEATPANTS_DESKTOP_IMAGE = '/images/collections/sweatpants-desktop-hero.jpg'

interface Props { products: Product[]; type: string | null; headingOverride?: string }

export function ShopClient({ products, type, headingOverride }: Props) {
  const { t } = useI18n()

  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'
  const isShopAll    = !type

  // ── Hero props ────────────────────────────────────────────────────────────
  const heroProps = isHoodies ? {
    desktopImage: HOODIES_DESKTOP_IMAGE,
    desktopAlt:   'Model wearing the Project KVRN heavyweight graphic hoodie',
    mobileImage:  '/images/collections/hoodies-mobile-hero.png',
    mobileAlt:    'Model wearing the Project KVRN heavyweight graphic hoodie',
    eyebrow1:     'PROJECT KVRN',
    eyebrow2:     'DROP 001',
    headline:     <><br />STRUCTURE<br />ABOVE ALL</>,
    specs1:       ['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY'],
    specs2:       ['CROPPED OVERSIZED FIT', 'DOUBLE-LAYER HOOD', 'DESIGNED TO LAST'],
    productLinks: undefined,
  } : isSweatpants ? {
    desktopImage: SWEATPANTS_DESKTOP_IMAGE,
    desktopAlt:   'Close view of the Project KVRN heavyweight wide-leg sweatpants',
    mobileImage:  '/images/collections/sweatpants-mobile-hero.png',
    mobileAlt:    'Close view of the Project KVRN heavyweight wide-leg sweatpants',
    eyebrow1:     'PROJECT KVRN',
    eyebrow2:     'DROP 001',
    headline:     <><br />WEIGHT<br />IN MOTION</>,
    specs1:       ['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY'],
    specs2:       ['WIDE-LEG FIT', 'DESIGNED TO DRAPE', 'DESIGNED TO LAST'],
    productLinks: undefined,
  } : {
    // Shop All
    desktopImage: SHOP_ALL_DESKTOP_IMAGE,
    desktopAlt:   'Model wearing the complete KVRN heavyweight hoodie and sweatpants set',
    mobileImage:  '/images/collections/shop-all-mobile-hero.png',
    mobileAlt:    'Model wearing the complete KVRN heavyweight hoodie and sweatpants set',
    eyebrow1:     'PROJECT KVRN',
    eyebrow2:     'DROP 001',
    headline:     <><br />THE COMPLETE<br />UNIFORM</>,
    specs1:       ['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY'],
    specs2:       ['HOODIE + SWEATPANTS', 'DESIGNED AS ONE SYSTEM', 'DESIGNED TO LAST'],
    productLinks: [
      {
        name:  'HEAVYWEIGHT HOODIE',
        price: '$80',
        href:  '/products/kvrn-phantom-hoodie',
        style: {
          right: 'clamp(48px, 7vw, 120px)',
          top:   '24%',
        },
      },
      {
        name:  'HEAVYWEIGHT SWEATPANTS',
        price: '$80',
        href:  '/products/kvrn-phantom-sweatpants',
        style: {
          right: 'clamp(48px, 7vw, 120px)',
          top:   '62%',
        },
      },
    ],
  }

  const TABS = [
    { label: t.shopAll,    href: '/shop',                  active: isShopAll },
    { label: t.hoodies,    href: '/shop?type=hoodies',     active: isHoodies },
    { label: t.sweatpants, href: '/shop?type=sweatpants',  active: isSweatpants },
  ]

  return (
    <div>
      {/* ── Collection Hero (desktop + mobile) ── */}
      <CollectionHero {...heroProps} />

      {/* ── Products below hero ── */}
      <div data-nav-theme="light" className="container-kvrn py-10 md:py-14">

        {/* Filter tabs */}
        <div className="flex gap-6 mb-10 border-b border-[#E8E5E0] pb-4">
          {TABS.map(tab => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`text-[11px] font-light tracking-[0.1em] uppercase pb-4 -mb-4 border-b-[1.5px] transition-colors duration-150 ${
                tab.active
                  ? 'border-[#1A1A1A] text-[#1A1A1A]'
                  : 'border-transparent text-[#9B9B9B] hover:text-[#1A1A1A]'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {/* Product grid */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
          {products.map((product, i) => (
            <ProductCard key={product.id} product={product} priority={i < 2} />
          ))}
        </div>

        {/* SEO / collection details */}
        <details className="mt-14 group">
          <summary className="text-[11px] tracking-[0.1em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors list-none flex items-center gap-2 cursor-pointer">
            About this collection
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none"
              className="transition-transform duration-200 group-open:rotate-180">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </summary>
          <div className="mt-4 max-w-xl text-[13px] text-[#6B6B6B] leading-relaxed space-y-2">
            <p>Project KVRN Drop 001. 500 GSM French terry blend, enzyme-washed for softness and pre-shrunk for longevity.</p>
            <p>Heavyweight hoodie and sweatpants designed as one system. Made to last.</p>
          </div>
        </details>
      </div>
    </div>
  )
}
