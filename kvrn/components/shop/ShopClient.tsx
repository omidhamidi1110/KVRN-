'use client'

import { CollectionHero } from '@/components/shop/CollectionHero'
import type { Product } from '@/types'

interface Props { products: Product[]; type: string | null; headingOverride?: string }

export function ShopClient({ products, type }: Props) {
  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'

  if (isHoodies) {
    return (
      <CollectionHero
        desktopImage="/images/collections/hoodies-desktop-hero.png"
        desktopAlt="Model wearing the Project KVRN heavyweight graphic hoodie"
        mobileImage="/images/collections/hoodies-mobile-hero.png"
        mobileAlt="Model wearing the Project KVRN heavyweight graphic hoodie"
        eyebrow1="PROJECT KVRN"
        eyebrow2="DROP 001"
        headlineLines={['STRUCTURE', 'ABOVE ALL']}
        specs1={['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY']}
        specs2={['CROPPED OVERSIZED FIT', 'DOUBLE-LAYER HOOD', 'DESIGNED TO LAST']}
      />
    )
  }

  if (isSweatpants) {
    return (
      <CollectionHero
        desktopImage="/images/collections/sweatpants-desktop-hero.png"
        desktopAlt="Close view of the Project KVRN heavyweight wide-leg sweatpants"
        mobileImage="/images/collections/sweatpants-mobile-hero.png"
        mobileAlt="Close view of the Project KVRN heavyweight wide-leg sweatpants"
        eyebrow1="PROJECT KVRN"
        eyebrow2="DROP 001"
        headlineLines={['WEIGHT', 'IN MOTION']}
        specs1={['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY']}
        specs2={['WIDE-LEG FIT', 'DESIGNED TO DRAPE', 'DESIGNED TO LAST']}
      />
    )
  }

  // Shop All
  return (
    <CollectionHero
      desktopImage="/images/collections/shop-all-desktop-hero.png"
      desktopAlt="Model wearing the complete KVRN heavyweight hoodie and sweatpants set"
      mobileImage="/images/collections/shop-all-mobile-hero.png"
      mobileAlt="Model wearing the complete KVRN heavyweight hoodie and sweatpants set"
      eyebrow1="PROJECT KVRN"
      eyebrow2="DROP 001"
      headlineLines={['THE COMPLETE', 'UNIFORM']}
      specs1={['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY']}
      specs2={['HOODIE + SWEATPANTS', 'DESIGNED AS ONE SYSTEM', 'DESIGNED TO LAST']}
      productLinks={[
        {
          name: 'HEAVYWEIGHT HOODIE',
          price: '$80',
          href: '/products/kvrn-phantom-hoodie',
          desktopStyle: { right: 'clamp(48px,7vw,120px)', top: '24%' },
        },
        {
          name: 'HEAVYWEIGHT SWEATPANTS',
          price: '$80',
          href: '/products/kvrn-phantom-sweatpants',
          desktopStyle: { right: 'clamp(48px,7vw,120px)', top: '62%' },
        },
      ]}
    />
  )
}
