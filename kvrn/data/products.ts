import type { Product } from '@/types'

// ─── PRODUCT DATA ─────────────────────────────────────────────────────────────
// Replace image src paths with actual product images before launch.
// Follow the naming convention: /images/products/{product}-{color}-{shot}.webp
// All images should be in WebP format, 3:4 aspect ratio (1500×2000px) for product shots.

export const products: Product[] = [
  // ─── HOODIE ────────────────────────────────────────────────────────────────
  {
    id: 'kh-001',
    name: 'KVRN Heavyweight Hoodie',
    slug: 'kvrn-heavyweight-hoodie',
    type: 'hoodie',
    price: 23000, // £230.00

    shortDescription: '400 GSM+ heavyweight fleece. Structured 3-panel hood.',

    description:
      'Built for the weight of daily life. 400 GSM+ heavyweight fleece — dense enough to hold its structure, considered enough to be worn without thinking. The 3-panel hood maintains form without drawstrings. Interior zipper compartments run parallel to both kangaroo pocket openings, invisible from outside. A single rubber patch marks the hood. Nothing else.',

    colors: [
      {
        name: 'Stone',
        value: 'stone',
        hex: '#C8B89A',
        pantone: 'Pantone 7527 C',
        images: [
          { src: '/images/products/hoodie-stone-front.webp',   alt: 'KVRN Heavyweight Hoodie in Stone, front view',                      type: 'front' },
          { src: '/images/products/hoodie-stone-back.webp',    alt: 'KVRN Heavyweight Hoodie in Stone, back view showing structured hood', type: 'back' },
          { src: '/images/products/hoodie-stone-hood.webp',    alt: 'KVRN 3-panel structured hood close-up, Stone colorway',             type: 'hood-macro' },
          { src: '/images/products/hoodie-stone-fabric.webp',  alt: '400 GSM heavyweight fleece fabric detail, triple-brushed interior',  type: 'fabric-macro' },
          { src: '/images/products/hoodie-stone-zip-closed.webp', alt: 'KVRN kangaroo pocket exterior — concealed zipper not visible',   type: 'zipper-closed' },
          { src: '/images/products/hoodie-stone-zip-open.webp',   alt: 'KVRN interior zipper compartment revealed behind pocket opening', type: 'zipper-open' },
          { src: '/images/products/hoodie-stone-lifestyle.webp',  alt: 'KVRN Heavyweight Hoodie worn, Stone colorway, architectural setting', type: 'lifestyle' },
        ],
      },
      {
        name: 'Slate',
        value: 'slate',
        hex: '#6B7280',
        pantone: 'Pantone 431 C',
        images: [
          { src: '/images/products/hoodie-slate-front.webp',   alt: 'KVRN Heavyweight Hoodie in Slate, front view',   type: 'front' },
          { src: '/images/products/hoodie-slate-back.webp',    alt: 'KVRN Heavyweight Hoodie in Slate, back view',    type: 'back' },
          { src: '/images/products/hoodie-slate-hood.webp',    alt: 'KVRN structured hood, Slate colorway',           type: 'hood-macro' },
          { src: '/images/products/hoodie-slate-fabric.webp',  alt: '400 GSM heavyweight fleece, Slate colorway',     type: 'fabric-macro' },
          { src: '/images/products/hoodie-slate-lifestyle.webp', alt: 'KVRN Heavyweight Hoodie worn, Slate colorway', type: 'lifestyle' },
        ],
      },
      {
        name: 'Off White',
        value: 'off-white',
        hex: '#F0EBE3',
        pantone: 'Pantone 9222 C',
        images: [
          { src: '/images/products/hoodie-offwhite-front.webp',   alt: 'KVRN Heavyweight Hoodie in Off White, front view', type: 'front' },
          { src: '/images/products/hoodie-offwhite-back.webp',    alt: 'KVRN Heavyweight Hoodie in Off White, back view',  type: 'back' },
          { src: '/images/products/hoodie-offwhite-lifestyle.webp', alt: 'KVRN Heavyweight Hoodie, Off White, worn',       type: 'lifestyle' },
        ],
      },
      {
        name: 'Washed Black',
        value: 'washed-black',
        hex: '#2D2D2D',
        pantone: 'Pantone Black 6 C',
        images: [
          { src: '/images/products/hoodie-washedblack-front.webp',   alt: 'KVRN Heavyweight Hoodie in Washed Black, front view', type: 'front' },
          { src: '/images/products/hoodie-washedblack-back.webp',    alt: 'KVRN Heavyweight Hoodie in Washed Black, back view',  type: 'back' },
          { src: '/images/products/hoodie-washedblack-lifestyle.webp', alt: 'KVRN Heavyweight Hoodie, Washed Black, worn',       type: 'lifestyle' },
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

    fitNote: 'Runs oversized. If between sizes, size down for a cleaner silhouette.',

    features: [
      {
        title: '400 GSM+ Fleece',
        description:
          'Triple-brushed interior. Dense, cold-resist face. The weight is structural — immediately perceptible the moment you lift it.',
      },
      {
        title: '3-Panel Structured Hood',
        description:
          'Three separately cut panels. The seaming creates a dome that holds form without support. No drawstring required.',
      },
      {
        title: 'Concealed Interior Zippers',
        description:
          'YKK coil zippers run parallel to both kangaroo pocket openings. Fully functional. Invisible from outside in any position.',
      },
      {
        title: 'No Drawstring',
        description:
          'Engineered not to need one. The hood structure is self-supporting. Nothing to pull, nothing to lose.',
      },
    ],

    specs: [
      { label: 'Material',      value: '100% ring-spun combed cotton' },
      { label: 'Weight',        value: '400 GSM+' },
      { label: 'Construction',  value: 'Loopback terry, triple-brushed interior' },
      { label: 'Hood',          value: '3-panel structured, no drawstring' },
      { label: 'Pockets',       value: 'Kangaroo with concealed interior YKK zippers' },
      { label: 'Branding',      value: 'Rubber patch, hood exterior only' },
      { label: 'Fit',           value: 'Oversized' },
      { label: 'Care',          value: 'Machine wash cold. Inside out. Air dry.' },
    ],

    relatedProductSlug: 'kvrn-heavyweight-sweatpants',

    seo: {
      title: 'KVRN Heavyweight Hoodie | 400 GSM Oversized Fleece | Stone, Slate, Off White',
      description:
        'KVRN Heavyweight Hoodie. 400 GSM+ fleece, structured 3-panel hood, concealed interior zippers, no drawstring. Available in Stone, Slate, Off White, Washed Black.',
    },
  },

  // ─── SWEATPANTS ────────────────────────────────────────────────────────────
  {
    id: 'ks-001',
    name: 'KVRN Heavyweight Sweatpants',
    slug: 'kvrn-heavyweight-sweatpants',
    type: 'sweatpants',
    price: 19000, // £190.00

    shortDescription: '400 GSM+ heavyweight fleece. Wide-leg. No compromise.',

    description:
      'The same 400 GSM+ fleece as the hoodie. A wide-leg silhouette that reads as intentional rather than relaxed. Elastic waistband with internal drawcord — tucked, not visible. Side pockets, back pocket with concealed zip. Designed as part of a set, functional as a standalone.',

    colors: [
      {
        name: 'Stone',
        value: 'stone',
        hex: '#C8B89A',
        pantone: 'Pantone 7527 C',
        images: [
          { src: '/images/products/sweatpants-stone-front.webp',   alt: 'KVRN Heavyweight Sweatpants in Stone, front view',    type: 'front' },
          { src: '/images/products/sweatpants-stone-back.webp',    alt: 'KVRN Heavyweight Sweatpants in Stone, back view',     type: 'back' },
          { src: '/images/products/sweatpants-stone-fabric.webp',  alt: '400 GSM heavyweight fleece, sweatpants detail',       type: 'fabric-macro' },
          { src: '/images/products/sweatpants-stone-lifestyle.webp', alt: 'KVRN Sweatpants worn, Stone colorway',              type: 'lifestyle' },
        ],
      },
      {
        name: 'Slate',
        value: 'slate',
        hex: '#6B7280',
        pantone: 'Pantone 431 C',
        images: [
          { src: '/images/products/sweatpants-slate-front.webp',   alt: 'KVRN Heavyweight Sweatpants in Slate, front view',   type: 'front' },
          { src: '/images/products/sweatpants-slate-back.webp',    alt: 'KVRN Heavyweight Sweatpants in Slate, back view',    type: 'back' },
          { src: '/images/products/sweatpants-slate-lifestyle.webp', alt: 'KVRN Sweatpants worn, Slate colorway',             type: 'lifestyle' },
        ],
      },
      {
        name: 'Off White',
        value: 'off-white',
        hex: '#F0EBE3',
        pantone: 'Pantone 9222 C',
        images: [
          { src: '/images/products/sweatpants-offwhite-front.webp', alt: 'KVRN Heavyweight Sweatpants in Off White, front view', type: 'front' },
          { src: '/images/products/sweatpants-offwhite-back.webp',  alt: 'KVRN Heavyweight Sweatpants in Off White, back view',  type: 'back' },
        ],
      },
      {
        name: 'Washed Black',
        value: 'washed-black',
        hex: '#2D2D2D',
        pantone: 'Pantone Black 6 C',
        images: [
          { src: '/images/products/sweatpants-washedblack-front.webp', alt: 'KVRN Heavyweight Sweatpants in Washed Black, front view', type: 'front' },
          { src: '/images/products/sweatpants-washedblack-back.webp',  alt: 'KVRN Heavyweight Sweatpants in Washed Black, back view',  type: 'back' },
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
        description:
          'The same triple-brushed heavyweight fleece as the hoodie. Consistent weight and hand feel across the full set.',
      },
      {
        title: 'Wide-Leg Silhouette',
        description:
          'A considered proportion — wide enough to read as architectural, structured enough to hold its shape.',
      },
      {
        title: 'Concealed Drawcord',
        description:
          'Elastic waistband with internal drawcord. Adjustable. Invisible from outside.',
      },
      {
        title: 'Back Zip Pocket',
        description:
          'Single back pocket with concealed YKK zip. Secure. Seamless with the garment exterior.',
      },
    ],

    specs: [
      { label: 'Material',      value: '100% ring-spun combed cotton' },
      { label: 'Weight',        value: '400 GSM+' },
      { label: 'Construction',  value: 'Loopback terry, triple-brushed interior' },
      { label: 'Waist',         value: 'Elastic with internal drawcord' },
      { label: 'Pockets',       value: 'Two side pockets, one back zip pocket' },
      { label: 'Leg',           value: 'Wide-leg, tapered at ankle' },
      { label: 'Branding',      value: 'None visible' },
      { label: 'Fit',           value: 'Oversized, wide-leg' },
      { label: 'Care',          value: 'Machine wash cold. Inside out. Air dry.' },
    ],

    relatedProductSlug: 'kvrn-heavyweight-hoodie',

    seo: {
      title: 'KVRN Heavyweight Sweatpants | 400 GSM Wide-Leg Fleece | Stone, Slate, Off White',
      description:
        'KVRN Heavyweight Sweatpants. 400 GSM+ fleece, wide-leg silhouette, concealed drawcord waistband, back zip pocket. The matching set.',
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

export function formatPrice(pence: number): string {
  return `£${(pence / 100).toFixed(0)}`
}

export function formatPriceDecimal(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`
}

// The set pricing — no discount; presented as the intended form
export const SET_PRICE = products.reduce((acc, p) => acc + p.price, 0)
