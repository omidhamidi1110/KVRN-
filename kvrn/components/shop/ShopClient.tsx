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
        desktopImage="/images/collections/hoodies-desktop-hero-no-text.jpeg"
        desktopAlt="Model wearing the Project KVRN heavyweight graphic hoodie"
        mobileImage="/images/collections/hoodies-mobile-hero.png"
        mobileAlt="Model wearing the Project KVRN heavyweight graphic hoodie"
        eyebrow1="PROJECT KVRN"
        eyebrow2="DROP 001"
        headlineLines={['STRUCTURE', 'ABOVE ALL']}
        specs1={['500 GSM', 'ENZYME-WASHED', 'FRENCH TERRY']}
        specs2={['CROPPED OVERSIZED FIT', 'SIGNATURE SLEEVE GRAPHICS', 'DESIGNED TO LAST']}
        desktopLink={{
          name:'HEAVYWEIGHT HOODIE', price:'$80',
          href:'/products/kvrn-phantom-hoodie',
          desktopStyle:{ top:'72%', right:'clamp(34px,3.8vw,58px)', width:'clamp(175px,13.5vw,205px)' },
        }}
        mobileLinks={[{
          name:'HEAVYWEIGHT HOODIE', price:'$80',
          href:'/products/kvrn-phantom-hoodie',
          desktopStyle:{},
        }]}
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
        desktopLink={{
          name:'HEAVYWEIGHT SWEATPANTS', price:'$80',
          href:'/products/kvrn-phantom-sweatpants',
          desktopStyle:{ top:'61%', right:'clamp(22px,2.2vw,34px)', width:'clamp(190px,14.5vw,215px)' },
        }}
        mobileLinks={[{
          name:'HEAVYWEIGHT SWEATPANTS', price:'$80',
          href:'/products/kvrn-phantom-sweatpants',
          desktopStyle:{},
        }]}
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
      specs2={['HOODIE + SWEATPANTS', 'BUILT TO BE WORN TOGETHER', 'DESIGNED TO LAST']}
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
      mobileLinks={[
        { name:'HEAVYWEIGHT HOODIE', price:'$80', href:'/products/kvrn-phantom-hoodie', desktopStyle:{} },
        { name:'HEAVYWEIGHT SWEATPANTS', price:'$80', href:'/products/kvrn-phantom-sweatpants', desktopStyle:{} },
      ]}
    />
  )
}
