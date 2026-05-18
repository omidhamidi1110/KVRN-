import type { Product } from '@/types'

// ─── PRICE NOTE ───────────────────────────────────────────────────────────────
// All prices stored as USD cents: 24000 = $240.00
// Currency conversion handled by CurrencyContext + lib/currency.ts

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
    'hoodie': 'KVRN Heavyweight Hoodie', 'sweatpants': 'KVRN Heavyweight Sweatpants',
    'phantom-hoodie': 'KVRN Phantom Hoodie', 'phantom-pants': 'KVRN Phantom Sweatpants',
  }
  return shots.map(shot => ({
    src: `/images/products/${product}-${color}-${shot}.webp`,
    alt: `${PROD_NAMES[product] ?? product} in ${color.replace('-', ' ')}, ${SHOT_ALTS[shot] ?? shot}`,
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

// ─── COLOR PALETTES ───────────────────────────────────────────────────────────

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

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

export const products: Product[] = [
  {
    id: 'kh-001', name: 'Heavyweight Hoodie', slug: 'kvrn-heavyweight-hoodie',
    type: 'hoodie', price: 24000,
    shortDescription: 'Brushed fleece, 400 GSM. Double-layered hood.',
    description: 'Built for the weight of daily life. 400 GSM brushed fleece — dense enough to feel structural, considered enough to be worn without thinking. The double-layered hood holds its form without drawstrings. Two concealed zipper compartments sit inside the kangaroo pocket, invisible from outside.',
    colors: HW_COLORS.map(c => ({
      ...c,
      images: imgs('hoodie', c.value, ['front', 'back', 'hood-macro', 'fabric-macro', 'zipper-closed', 'zipper-open', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Runs oversized. If between sizes, size down for a cleaner silhouette.',
    features: [
      { title: '400 GSM Brushed Fleece', description: '100% cotton. Dense, cold-resist face with a brushed interior. Perceptible weight from the first lift.' },
      { title: 'Double-Layered Hood', description: 'Structured construction holds its form without a drawstring. Nothing to adjust.' },
      { title: 'Two Hidden Zipper Pockets', description: 'Concealed zip compartments inside the kangaroo pocket — one each side. Secure. Invisible from outside.' },
      { title: 'No Drawstring', description: 'Engineered not to need one. The hood structure does the work.' },
    ],
    specs: [
      { label: 'Material', value: '100% Cotton' },
      { label: 'Weight',   value: '400 GSM' },
      { label: 'Construction', value: 'Brushed fleece' },
      { label: 'Hood',     value: 'Double-layered, no drawstring' },
      { label: 'Pockets',  value: 'Kangaroo with 2 concealed interior zippers' },
      { label: 'Branding', value: 'Minimal rubber patch, hood only' },
      { label: 'Fit',      value: 'Oversized' },
      { label: 'Care',     value: 'Machine wash cold. Inside out. Air dry.' },
    ],
    relatedProductSlug: 'kvrn-heavyweight-sweatpants',
    seo: {
      title: 'KVRN Heavyweight Hoodie | 400 GSM Brushed Fleece | 5 Colorways',
      description: 'KVRN Heavyweight Hoodie. 400 GSM brushed fleece, 100% cotton. Double-layered structured hood. Two hidden zipper pockets. No drawstring.',
    },
  },

  {
    id: 'ks-001', name: 'Heavyweight Sweatpants', slug: 'kvrn-heavyweight-sweatpants',
    type: 'sweatpants', price: 19500,
    shortDescription: 'Brushed fleece, 400 GSM. Wide-leg silhouette.',
    description: 'The same 400 GSM brushed fleece as the hoodie. A wide-leg silhouette with considered proportions — generous without being shapeless. Concealed elastic waistband with internal drawcord.',
    colors: HW_COLORS.map(c => ({
      ...c,
      images: imgs('sweatpants', c.value, ['front', 'back', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Wide-leg, sits at natural waist. True to size.',
    features: [
      { title: '400 GSM Brushed Fleece', description: 'The same 100% cotton brushed fleece as the hoodie. Consistent weight across the full set.' },
      { title: 'Wide-Leg Silhouette', description: 'A considered proportion. Generous enough to feel relaxed, structured enough to hold its shape.' },
      { title: 'Concealed Waistband', description: 'Elastic with internal drawcord. Adjustable from inside. Nothing visible from out.' },
    ],
    specs: [
      { label: 'Material', value: '100% Cotton' },
      { label: 'Weight',   value: '400 GSM' },
      { label: 'Construction', value: 'Brushed fleece' },
      { label: 'Waist',    value: 'Elastic with internal drawcord' },
      { label: 'Pockets',  value: 'Two side pockets' },
      { label: 'Leg',      value: 'Wide-leg' },
      { label: 'Branding', value: 'None visible' },
      { label: 'Care',     value: 'Machine wash cold. Inside out. Air dry.' },
    ],
    relatedProductSlug: 'kvrn-heavyweight-hoodie',
    seo: {
      title: 'KVRN Heavyweight Sweatpants | 400 GSM Wide-Leg | 5 Colorways',
      description: 'KVRN Heavyweight Sweatpants. 400 GSM brushed fleece. Wide-leg silhouette. Concealed elastic waistband. Available in 5 colorways.',
    },
  },

  {
    id: 'kph-001', name: 'Phantom Hoodie', slug: 'kvrn-phantom-hoodie',
    type: 'hoodie', price: 26500,
    shortDescription: '500 GSM French terry blend. Oversized, cropped.',
    description: 'Phantom is cut in a heavier French terry blend with an oversized, cropped proportion. Enzyme washed for a softer hand feel and finished for everyday wear. Pre-shrunk, wrinkle-resistant, and built to stay that way.',
    colors: PH_COLORS.map(c => ({
      ...c,
      images: imgs('phantom-hoodie', c.value, ['front', 'back', 'hood-macro', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Cropped oversized fit. Size up for more coverage, size down for the intended proportion.',
    features: [
      { title: '500 GSM French Terry Blend', description: '70% cotton, 30% polyester. Heavier than the standard collection. Dense with a slightly textured face.' },
      { title: 'Enzyme Washed', description: 'Each piece is enzyme washed before shipping for an immediate softness. No break-in period.' },
      { title: 'Pre-Shrunk', description: 'Pre-shrunk to lock in the fit. Wrinkle-resistant finish maintains the silhouette through regular wear.' },
      { title: 'Cropped Proportion', description: 'Sits at the hip rather than the thigh. The intended silhouette for the Phantom collection.' },
    ],
    specs: [
      { label: 'Material', value: '70% Cotton, 30% Polyester' },
      { label: 'Weight',   value: '500 GSM' },
      { label: 'Construction', value: 'French terry blend' },
      { label: 'Finish',   value: 'Enzyme washed, wrinkle-resistant' },
      { label: 'Pre-shrunk', value: 'Yes' },
      { label: 'Fit',      value: 'Oversized, cropped' },
      { label: 'Care',     value: 'Machine wash cold. Tumble dry low.' },
    ],
    relatedProductSlug: 'kvrn-phantom-sweatpants',
    seo: {
      title: 'KVRN Phantom Hoodie | 500 GSM French Terry | Oversized Cropped',
      description: 'KVRN Phantom Hoodie. 500 GSM French terry blend, 70% cotton 30% polyester. Enzyme washed, pre-shrunk. Cropped oversized fit. Black.',
    },
  },

  {
    id: 'kps-001', name: 'Phantom Sweatpants', slug: 'kvrn-phantom-sweatpants',
    type: 'sweatpants', price: 21500,
    shortDescription: '500 GSM French terry blend. Relaxed oversized fit.',
    description: 'Phantom Sweatpants use the same 500 GSM French terry blend with a relaxed oversized fit. Pre-shrunk, enzyme washed, and finished for a clean daily silhouette.',
    colors: PH_COLORS.map(c => ({
      ...c,
      images: imgs('phantom-pants', c.value, ['front', 'back', 'fabric-macro', 'lifestyle']),
    })),
    sizes: STANDARD_SIZES,
    fitNote: 'Relaxed oversized fit. True to size.',
    features: [
      { title: '500 GSM French Terry Blend', description: '70% cotton, 30% polyester. The same blend as the Phantom Hoodie — consistent weight and hand feel across the set.' },
      { title: 'Enzyme Washed', description: 'Washed before shipping for immediate softness.' },
      { title: 'Pre-Shrunk', description: 'Holds its shape through regular wear and washing. Wrinkle-resistant finish.' },
    ],
    specs: [
      { label: 'Material', value: '70% Cotton, 30% Polyester' },
      { label: 'Weight',   value: '500 GSM' },
      { label: 'Construction', value: 'French terry blend' },
      { label: 'Finish',   value: 'Enzyme washed, wrinkle-resistant' },
      { label: 'Pre-shrunk', value: 'Yes' },
      { label: 'Waist',    value: 'Elastic with internal drawcord' },
      { label: 'Fit',      value: 'Relaxed oversized' },
      { label: 'Care',     value: 'Machine wash cold. Tumble dry low.' },
    ],
    relatedProductSlug: 'kvrn-phantom-hoodie',
    seo: {
      title: 'KVRN Phantom Sweatpants | 500 GSM French Terry | Relaxed Fit',
      description: 'KVRN Phantom Sweatpants. 500 GSM French terry blend. Enzyme washed, pre-shrunk. Relaxed oversized fit. Black.',
    },
  },
]

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export function getProductBySlug(slug: string): Product | undefined {
  return products.find(p => p.slug === slug)
}

export function getAllProductSlugs(): string[] {
  return products.map(p => p.slug)
}

export function getProductsByType(type: 'hoodie' | 'sweatpants'): Product[] {
  return products.filter(p => p.type === type)
}

/** Simple USD formatter — use useCurrency().formatPrice() in components when possible */
export function formatPrice(usdCents: number): string {
  return `$${Math.round(usdCents / 100)}`
}
