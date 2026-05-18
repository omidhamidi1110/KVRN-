import type { Product } from '@/types'

// Prices in USD cents. $80 = 8000 cents (Founder Price)
const FOUNDER_PRICE = 8000
const FOUNDER_NOTE  = 'Founder pricing — permanently increases after initial release.'

type ColorDef = { name: string; value: string; hex: string }
type ShotType = import('@/types').ImageType

function imgs(product: string, color: string, shots: string[]) {
  const SHOT_ALTS: Record<string, string> = {
    front: 'front view', back: 'back view',
    'hood-macro': 'hood detail', 'fabric-macro': 'fabric texture',
    'zipper-closed': 'pocket exterior', 'zipper-open': 'hidden zipper revealed',
    lifestyle: 'worn lifestyle', 'flat-lay': 'flat lay', detail: 'detail',
  }
  const PROD_NAMES: Record<string, string> = {
    'hoodie': 'KVRN Heavyweight Hoodie',
    'sweatpants': 'KVRN Heavyweight Sweatpants',
    'phantom-hoodie': 'KVRN Phantom Hoodie',
    'phantom-pants': 'KVRN Phantom Sweatpants',
  }
  return shots.map(shot => ({
    src: `/images/products/${product}-${color}-${shot}.webp`,
    alt: `${PROD_NAMES[product] ?? product} in ${color.replace(/-/g, ' ')}, ${SHOT_ALTS[shot] ?? shot}`,
    type: shot as ShotType,
  }))
}

const STANDARD_SIZES = [
  { label: 'XS' as const, value: 'xs', inStock: true },
  { label: 'S'  as const, value: 's',  inStock: true },
  { label: 'M'  as const, value: 'm',  inStock: true },
  { label: 'L'  as const, value: 'l',  inStock: true },
  { label: 'XL' as const, value: 'xl', inStock: true },
  { label: 'XXL'as const, value: 'xxl',inStock: true },
]

const HW_COLORS: ColorDef[] = [
  { name: 'Black',     value: 'black',     hex: '#111111' },
  { name: 'Dark Grey', value: 'dark-grey', hex: '#3A3A3A' },
  { name: 'Grey',      value: 'grey',      hex: '#7A7A7A' },
  { name: 'Brown',     value: 'brown',     hex: '#6B4C2A' },
  { name: 'Plum',      value: 'plum',      hex: '#52274A' },
]

const PH_COLORS: ColorDef[] = [
  { name: 'Black', value: 'black', hex: '#0A0A0A' },
]

export const products: Product[] = [
  // ── Heavyweight Hoodie ──────────────────────────────────────────────────────
  {
    id: 'kh-001', name: 'Heavyweight Hoodie', slug: 'kvrn-heavyweight-hoodie',
    type: 'hoodie', price: FOUNDER_PRICE,
    founderNote: FOUNDER_NOTE,
    shortDescription: '400 GSM brushed fleece. Double-layered hood.',
    description: '400 GSM brushed fleece, 100% cotton. The double-layered hood holds its shape without a drawstring. Two hidden zipper compartments sit inside the kangaroo pocket — secure and invisible from outside.',
    colors: HW_COLORS.map(c => ({
      ...c,
      images: imgs('hoodie', c.value, ['front', 'back', 'hood-macro', 'fabric-macro', 'zipper-closed', 'zipper-open', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Runs oversized. If between sizes, size down for a cleaner fit.',
    features: [
      { title: '400 GSM Brushed Fleece', description: '100% cotton. Dense face, soft brushed interior. Built for daily wear.' },
      { title: 'Double-Layered Hood', description: 'Holds its shape without a drawstring. Nothing to adjust.' },
      { title: 'Hidden Zipper Pockets', description: 'Two concealed zip compartments inside the kangaroo pocket. Secure and invisible.' },
    ],
    specs: [
      { label: 'Material',     value: '100% Cotton' },
      { label: 'Weight',       value: '400 GSM' },
      { label: 'Construction', value: 'Brushed fleece' },
      { label: 'Hood',         value: 'Double-layered, no drawstring' },
      { label: 'Pockets',      value: 'Kangaroo with 2 concealed interior zippers' },
      { label: 'Fit',          value: 'Oversized' },
      { label: 'Care',         value: 'Machine wash cold. Inside out. Air dry.' },
    ],
    relatedProductSlug: 'kvrn-heavyweight-sweatpants',
    seo: {
      title: 'KVRN Heavyweight Hoodie | 400 GSM Brushed Fleece | Founder Price $80',
      description: 'KVRN Heavyweight Hoodie. 400 GSM brushed fleece, 100% cotton. Double-layered structured hood, no drawstring. Two hidden zipper pockets. Five colorways. Founder price $80.',
    },
  },

  // ── Heavyweight Sweatpants ──────────────────────────────────────────────────
  {
    id: 'ks-001', name: 'Heavyweight Sweatpants', slug: 'kvrn-heavyweight-sweatpants',
    type: 'sweatpants', price: FOUNDER_PRICE,
    founderNote: FOUNDER_NOTE,
    shortDescription: '400 GSM brushed fleece. Wide-leg silhouette.',
    description: 'The same 400 GSM brushed fleece as the hoodie. Wide-leg cut with a concealed elastic waistband and internal drawcord. Built for daily wear.',
    colors: HW_COLORS.map(c => ({
      ...c,
      images: imgs('sweatpants', c.value, ['front', 'back', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Wide-leg. Sits at natural waist. True to size.',
    features: [
      { title: '400 GSM Brushed Fleece', description: '100% cotton. Same weight and hand feel as the hoodie.' },
      { title: 'Wide-Leg Silhouette', description: 'Generous without being shapeless. Holds its form through regular wear.' },
      { title: 'Concealed Waistband', description: 'Elastic with internal drawcord. Nothing visible from outside.' },
    ],
    specs: [
      { label: 'Material',     value: '100% Cotton' },
      { label: 'Weight',       value: '400 GSM' },
      { label: 'Construction', value: 'Brushed fleece' },
      { label: 'Waist',        value: 'Elastic with internal drawcord' },
      { label: 'Pockets',      value: 'Two side pockets' },
      { label: 'Leg',          value: 'Wide-leg' },
      { label: 'Fit',          value: 'Oversized' },
      { label: 'Care',         value: 'Machine wash cold. Inside out. Air dry.' },
    ],
    relatedProductSlug: 'kvrn-heavyweight-hoodie',
    seo: {
      title: 'KVRN Heavyweight Sweatpants | 400 GSM Wide-Leg | Founder Price $80',
      description: 'KVRN Heavyweight Sweatpants. 400 GSM brushed fleece. Wide-leg silhouette. Concealed elastic waistband. Five colorways. Founder price $80.',
    },
  },

  // ── Phantom Hoodie ──────────────────────────────────────────────────────────
  {
    id: 'kph-001', name: 'Phantom Hoodie', slug: 'kvrn-phantom-hoodie',
    type: 'hoodie', price: FOUNDER_PRICE,
    founderNote: FOUNDER_NOTE,
    shortDescription: '500 GSM French terry blend. Oversized, cropped.',
    description: 'Phantom is cut in a heavier French terry blend with an oversized, cropped proportion. Enzyme washed for a softer hand feel and finished for everyday wear.',
    colors: PH_COLORS.map(c => ({
      ...c,
      images: imgs('phantom-hoodie', c.value, ['front', 'back', 'hood-macro', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Cropped oversized fit. Size up for more length.',
    features: [
      { title: '500 GSM French Terry Blend', description: '70% cotton, 30% polyester. Heavier than the standard collection.' },
      { title: 'Enzyme Washed', description: 'Washed before shipping for immediate softness. No break-in period.' },
      { title: 'Pre-Shrunk', description: 'Holds its shape through regular wear and washing.' },
    ],
    specs: [
      { label: 'Material',     value: '70% Cotton, 30% Polyester' },
      { label: 'Weight',       value: '500 GSM' },
      { label: 'Construction', value: 'French terry blend' },
      { label: 'Finish',       value: 'Enzyme washed, wrinkle-resistant' },
      { label: 'Pre-shrunk',   value: 'Yes' },
      { label: 'Fit',          value: 'Oversized, cropped' },
      { label: 'Care',         value: 'Machine wash cold. Tumble dry low.' },
    ],
    relatedProductSlug: 'kvrn-phantom-sweatpants',
    seo: {
      title: 'KVRN Phantom Hoodie | 500 GSM French Terry | Founder Price $80',
      description: 'KVRN Phantom Hoodie. 500 GSM French terry blend, enzyme washed, pre-shrunk. Cropped oversized fit. Black. Founder price $80.',
    },
  },

  // ── Phantom Sweatpants ──────────────────────────────────────────────────────
  {
    id: 'kps-001', name: 'Phantom Sweatpants', slug: 'kvrn-phantom-sweatpants',
    type: 'sweatpants', price: FOUNDER_PRICE,
    founderNote: FOUNDER_NOTE,
    shortDescription: '500 GSM French terry blend. Relaxed oversized fit.',
    description: 'Phantom Sweatpants use the same 500 GSM French terry blend with a relaxed oversized fit. Pre-shrunk, enzyme washed, and finished for a clean daily silhouette.',
    colors: PH_COLORS.map(c => ({
      ...c,
      images: imgs('phantom-pants', c.value, ['front', 'back', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Relaxed oversized fit. True to size.',
    features: [
      { title: '500 GSM French Terry Blend', description: '70% cotton, 30% polyester. Same blend as the Phantom Hoodie.' },
      { title: 'Enzyme Washed', description: 'Immediate softness from first wear.' },
      { title: 'Pre-Shrunk', description: 'Holds its shape through regular wear and washing.' },
    ],
    specs: [
      { label: 'Material',     value: '70% Cotton, 30% Polyester' },
      { label: 'Weight',       value: '500 GSM' },
      { label: 'Construction', value: 'French terry blend' },
      { label: 'Finish',       value: 'Enzyme washed, wrinkle-resistant' },
      { label: 'Pre-shrunk',   value: 'Yes' },
      { label: 'Waist',        value: 'Elastic with internal drawcord' },
      { label: 'Fit',          value: 'Relaxed oversized' },
      { label: 'Care',         value: 'Machine wash cold. Tumble dry low.' },
    ],
    relatedProductSlug: 'kvrn-phantom-hoodie',
    seo: {
      title: 'KVRN Phantom Sweatpants | 500 GSM French Terry | Founder Price $80',
      description: 'KVRN Phantom Sweatpants. 500 GSM French terry blend. Enzyme washed, pre-shrunk. Relaxed oversized fit. Black. Founder price $80.',
    },
  },
]

export function getProductBySlug(slug: string): Product | undefined {
  return products.find(p => p.slug === slug)
}

export function getAllProductSlugs(): string[] {
  return products.map(p => p.slug)
}

export function getProductsByType(type: 'hoodie' | 'sweatpants'): Product[] {
  return products.filter(p => p.type === type)
}

export function formatPrice(usdCents: number): string {
  return `$${Math.round(usdCents / 100)}`
}
