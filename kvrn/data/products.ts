import type { Product } from '@/types'

// ─── CURRENCY CONFIG ─────────────────────────────────────────────────────────
// All prices stored in cents (USD). formatPrice converts for display.
// Update CURRENCY_CONFIG when adding multi-currency support.

export const CURRENCY_CONFIG = {
  code:   'USD',
  symbol: '$',
  locale: 'en-US',
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`
}

export function formatPriceDecimal(cents: number): string {
  return new Intl.NumberFormat(CURRENCY_CONFIG.locale, {
    style:    'currency',
    currency: CURRENCY_CONFIG.code,
    minimumFractionDigits: 0,
  }).format(cents / 100)
}

// ─── PRODUCT CATALOG ─────────────────────────────────────────────────────────

export const products: Product[] = [
  {
    id:   'kh-001',
    name: 'Heavyweight Hoodie',
    slug: 'kvrn-heavyweight-hoodie',
    type: 'hoodie',
    price: 29000, // $290

    shortDescription: '400 GSM+ fleece. Structured 3-panel hood. No drawstring.',

    description:
      'The KVRN Heavyweight Hoodie is built from 400 GSM+ loopback terry fleece — dense enough to hold structural form, refined enough to wear without thought. The three-panel hood maintains its architecture without a drawstring. Interior zipper compartments run behind both kangaroo pocket openings, invisible in every position. A single moulded rubber patch on the hood exterior. Nothing else.',

    colors: [
      {
        name: 'Stone',
        value: 'stone',
        hex: '#C4B49A',
        images: [
          { src: '/images/products/hoodie-stone-01.jpg', alt: 'KVRN Heavyweight Hoodie in Stone — front view, structured hood down', type: 'front' },
          { src: '/images/products/hoodie-stone-02.jpg', alt: 'KVRN Heavyweight Hoodie in Stone — back view, three-panel hood visible', type: 'back' },
          { src: '/images/products/hoodie-stone-03.jpg', alt: 'KVRN Heavyweight Hoodie — structured hood worn up, architectural form', type: 'hood-macro' },
          { src: '/images/products/hoodie-stone-04.jpg', alt: '400 GSM heavyweight fleece — triple-brushed interior texture detail', type: 'fabric-macro' },
          { src: '/images/products/hoodie-stone-05.jpg', alt: 'KVRN kangaroo pocket exterior — concealed zipper not visible', type: 'zipper-closed' },
          { src: '/images/products/hoodie-stone-06.jpg', alt: 'KVRN interior zipper compartment — revealed behind pocket opening', type: 'zipper-open' },
          { src: '/images/products/hoodie-stone-07.jpg', alt: 'KVRN Heavyweight Hoodie worn — Stone colorway, architectural environment', type: 'lifestyle' },
        ],
      },
      {
        name: 'Slate',
        value: 'slate',
        hex: '#5C6470',
        images: [
          { src: '/images/products/hoodie-slate-01.jpg', alt: 'KVRN Heavyweight Hoodie in Slate — front view', type: 'front' },
          { src: '/images/products/hoodie-slate-02.jpg', alt: 'KVRN Heavyweight Hoodie in Slate — back view', type: 'back' },
          { src: '/images/products/hoodie-slate-03.jpg', alt: 'KVRN Heavyweight Hoodie in Slate — lifestyle', type: 'lifestyle' },
        ],
      },
      {
        name: 'Off White',
        value: 'off-white',
        hex: '#EDE8E0',
        images: [
          { src: '/images/products/hoodie-offwhite-01.jpg', alt: 'KVRN Heavyweight Hoodie in Off White — front view', type: 'front' },
          { src: '/images/products/hoodie-offwhite-02.jpg', alt: 'KVRN Heavyweight Hoodie in Off White — back view', type: 'back' },
        ],
      },
      {
        name: 'Washed Black',
        value: 'washed-black',
        hex: '#2A2A2A',
        images: [
          { src: '/images/products/hoodie-washedblack-01.jpg', alt: 'KVRN Heavyweight Hoodie in Washed Black — front view', type: 'front' },
          { src: '/images/products/hoodie-washedblack-02.jpg', alt: 'KVRN Heavyweight Hoodie in Washed Black — back view', type: 'back' },
        ],
      },
    ],

    sizes: [
      { label: 'XS',  value: 'xs',  inStock: true },
      { label: 'S',   value: 's',   inStock: true },
      { label: 'M',   value: 'm',   inStock: true },
      { label: 'L',   value: 'l',   inStock: true },
      { label: 'XL',  value: 'xl',  inStock: true },
      { label: 'XXL', value: 'xxl', inStock: false },
    ],

    fitNote: 'Designed oversized. Size down for a closer silhouette.',

    features: [
      {
        title: '400 GSM+ Fleece',
        description: 'Triple-brushed loopback terry. Dense, cold-resist face. Tested per production batch — minimum 390 GSM accepted.',
      },
      {
        title: '3-Panel Structured Hood',
        description: 'Three cut panels seamed to form a self-supporting dome. Holds its shape without external support.',
      },
      {
        title: 'Interior Zipper Pockets',
        description: 'YKK coil zippers run parallel to both kangaroo pocket openings. Invisible externally in any position.',
      },
      {
        title: 'No Drawstring',
        description: 'The hood structure is engineered not to require one. No silhouette interruption. Nothing to lose.',
      },
    ],

    specs: [
      { label: 'Material',     value: '100% ring-spun combed cotton' },
      { label: 'Weight',       value: '400 GSM+' },
      { label: 'Construction', value: 'Loopback terry, triple-brushed interior' },
      { label: 'Hood',         value: '3-panel structured, no drawstring' },
      { label: 'Pockets',      value: 'Kangaroo with concealed interior YKK zippers' },
      { label: 'Branding',     value: 'Moulded rubber patch, hood exterior only' },
      { label: 'Fit',          value: 'Oversized' },
      { label: 'Care',         value: 'Machine wash cold, inside out. Air dry.' },
    ],

    relatedProductSlug: 'kvrn-heavyweight-sweatpants',

    seo: {
      title: 'KVRN Heavyweight Hoodie — 400 GSM Oversized Fleece',
      description:
        'KVRN Heavyweight Hoodie. 400 GSM+ ring-spun cotton fleece. Structured 3-panel hood. Concealed interior YKK zippers. No drawstring. Four colorways.',
    },
  },

  {
    id:   'ks-001',
    name: 'Heavyweight Sweatpants',
    slug: 'kvrn-heavyweight-sweatpants',
    type: 'sweatpants',
    price: 25000, // $250

    shortDescription: '400 GSM+ fleece. Wide-leg. Concealed drawcord. Back zip pocket.',

    description:
      'Cut from the same 400 GSM+ loopback terry as the hoodie. A wide-leg silhouette proportioned to sit beside the hoodie as a unified system. Elastic waistband with internal drawcord — functional, invisible. Two side pockets. One back zip pocket, concealed at the seam. No visible branding.',

    colors: [
      {
        name: 'Stone',
        value: 'stone',
        hex: '#C4B49A',
        images: [
          { src: '/images/products/sweatpants-stone-01.jpg', alt: 'KVRN Heavyweight Sweatpants in Stone — front view', type: 'front' },
          { src: '/images/products/sweatpants-stone-02.jpg', alt: 'KVRN Heavyweight Sweatpants in Stone — back view', type: 'back' },
          { src: '/images/products/sweatpants-stone-03.jpg', alt: '400 GSM heavyweight fleece — sweatpants fabric detail', type: 'fabric-macro' },
          { src: '/images/products/sweatpants-stone-04.jpg', alt: 'KVRN Heavyweight Sweatpants — worn, Stone colorway', type: 'lifestyle' },
        ],
      },
      {
        name: 'Slate',
        value: 'slate',
        hex: '#5C6470',
        images: [
          { src: '/images/products/sweatpants-slate-01.jpg', alt: 'KVRN Heavyweight Sweatpants in Slate — front view', type: 'front' },
          { src: '/images/products/sweatpants-slate-02.jpg', alt: 'KVRN Heavyweight Sweatpants in Slate — back view', type: 'back' },
        ],
      },
      {
        name: 'Off White',
        value: 'off-white',
        hex: '#EDE8E0',
        images: [
          { src: '/images/products/sweatpants-offwhite-01.jpg', alt: 'KVRN Heavyweight Sweatpants in Off White — front view', type: 'front' },
          { src: '/images/products/sweatpants-offwhite-02.jpg', alt: 'KVRN Heavyweight Sweatpants in Off White — back view', type: 'back' },
        ],
      },
      {
        name: 'Washed Black',
        value: 'washed-black',
        hex: '#2A2A2A',
        images: [
          { src: '/images/products/sweatpants-washedblack-01.jpg', alt: 'KVRN Heavyweight Sweatpants in Washed Black — front view', type: 'front' },
          { src: '/images/products/sweatpants-washedblack-02.jpg', alt: 'KVRN Heavyweight Sweatpants in Washed Black — back view', type: 'back' },
        ],
      },
    ],

    sizes: [
      { label: 'XS',  value: 'xs',  inStock: true },
      { label: 'S',   value: 's',   inStock: true },
      { label: 'M',   value: 'm',   inStock: true },
      { label: 'L',   value: 'l',   inStock: true },
      { label: 'XL',  value: 'xl',  inStock: true },
      { label: 'XXL', value: 'xxl', inStock: true },
    ],

    fitNote: 'Wide-leg, sits at natural waist. True to size.',

    features: [
      {
        title: '400 GSM+ Fleece',
        description: 'Same triple-brushed loopback terry as the hoodie. Consistent weight across the full system.',
      },
      {
        title: 'Wide-Leg Silhouette',
        description: 'Proportioned deliberately — wide enough to carry structural presence, tapered enough at the ankle to stay precise.',
      },
      {
        title: 'Concealed Drawcord',
        description: 'Elastic waistband with internal drawcord. Adjustable, invisible from the exterior.',
      },
      {
        title: 'Back Zip Pocket',
        description: 'Single back pocket with concealed YKK zip at the seam. Secure. Seamless with the garment exterior.',
      },
    ],

    specs: [
      { label: 'Material',     value: '100% ring-spun combed cotton' },
      { label: 'Weight',       value: '400 GSM+' },
      { label: 'Construction', value: 'Loopback terry, triple-brushed interior' },
      { label: 'Waist',        value: 'Elastic with internal drawcord' },
      { label: 'Pockets',      value: 'Two side pockets, one back zip pocket' },
      { label: 'Leg',          value: 'Wide-leg, tapered at ankle' },
      { label: 'Branding',     value: 'None visible' },
      { label: 'Care',         value: 'Machine wash cold, inside out. Air dry.' },
    ],

    relatedProductSlug: 'kvrn-heavyweight-hoodie',

    seo: {
      title: 'KVRN Heavyweight Sweatpants — 400 GSM Wide-Leg Fleece',
      description:
        'KVRN Heavyweight Sweatpants. 400 GSM+ ring-spun cotton fleece. Wide-leg silhouette. Concealed drawcord. Back zip pocket. No visible branding.',
    },
  },
]

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export function getProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug)
}

export function getAllProductSlugs(): string[] {
  return products.map((p) => p.slug)
}

export const SET_PRICE_CENTS = products.reduce((acc, p) => acc + p.price, 0)
