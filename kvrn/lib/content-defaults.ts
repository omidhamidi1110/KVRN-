// lib/content-defaults.ts — the CODED content of the storefront shell and slot pages.
//
// These constants are the OFF-path of the CMS_PUBLIC_CONTENT flag and the SEED of the CMS:
//   * With the flag OFF the shell/pages render exactly these values (the old hardcoded content).
//   * Migration 030 seeds the very same values into the CMS, so switching the flag ON changes
//     nothing visually until an editor changes something.
//   * lib/__tests__/content-defaults.test.ts proves the coded components still contain these
//     strings (so the two cannot drift silently).
// PURE module: no DB, no React.

import type {
  NavigationSnapshot, FooterSnapshot, AnnouncementSnapshot, AboutSnapshot, ContactSnapshot, SupportPageSnapshot, GlobalSeo,
} from './content-schemas'
import { para } from './content-richtext'

export const SITE_ORIGIN_FALLBACK = 'https://kvrn.shop'

export const DEFAULT_NAVIGATION: NavigationSnapshot = {
  desktop: [
    { id: 'd-shop-all',   label: 'Shop All',   href: '/shop',                i18nKey: 'shopAll',    i18nEn: 'Shop All' },
    { id: 'd-hoodies',    label: 'Hoodies',    href: '/shop?type=hoodies',    i18nKey: 'hoodies',    i18nEn: 'Hoodies' },
    { id: 'd-sweatpants', label: 'Sweatpants', href: '/shop?type=sweatpants', i18nKey: 'sweatpants', i18nEn: 'Sweatpants' },
    { id: 'd-track',      label: 'Track Order',href: '/support/track',        i18nKey: 'trackOrder', i18nEn: 'Track Order' },
    { id: 'd-about',      label: 'About',      href: '/about',                i18nKey: 'about',      i18nEn: 'About' },
    { id: 'd-contact',    label: 'Contact',    href: '/contact',              i18nKey: 'contact',    i18nEn: 'Contact' },
  ],
  mobile: [
    { id: 'm-shop-all',   label: 'Shop All',   href: '/shop',                i18nKey: 'shopAll',    i18nEn: 'Shop All' },
    { id: 'm-hoodies',    label: 'Hoodies',    href: '/shop?type=hoodies',    i18nKey: 'hoodies',    i18nEn: 'Hoodies' },
    { id: 'm-sweatpants', label: 'Sweatpants', href: '/shop?type=sweatpants', i18nKey: 'sweatpants', i18nEn: 'Sweatpants' },
    { id: 'm-about',      label: 'About',      href: '/about',                i18nKey: 'about',      i18nEn: 'About' },
    { id: 'm-size-guide', label: 'Size Guide', href: '/support/size-guide',   i18nKey: 'sizeGuide',  i18nEn: 'Size Guide' },
    { id: 'm-track',      label: 'Track Order',href: '/support/track',        i18nKey: 'trackOrder', i18nEn: 'Track Order' },
    { id: 'm-faq',        label: 'FAQ',        href: '/support/faq',          i18nKey: 'faq',        i18nEn: 'FAQ' },
    { id: 'm-shipping',   label: 'Shipping & Returns', href: '/support/shipping-returns', i18nKey: 'shippingReturns', i18nEn: 'Shipping & Returns' },
    { id: 'm-contact',    label: 'Contact',    href: '/contact',              i18nKey: 'contact',    i18nEn: 'Contact' },
  ],
}

export const DEFAULT_FOOTER: FooterSnapshot = {
  brandName: 'KVRN',
  taglines: ['Quiet garments.', 'Built with intention.'],
  groups: [
    { id: 'shop', heading: 'Shop', i18nKey: 'shop', i18nEn: 'Shop', links: [
      { id: 'f-shop-all',   label: 'Shop All',   href: '/shop' },
      { id: 'f-hoodies',    label: 'Hoodies',    href: '/shop?type=hoodies' },
      { id: 'f-sweatpants', label: 'Sweatpants', href: '/shop?type=sweatpants' },
    ] },
    { id: 'support', heading: 'Support', i18nKey: 'support', i18nEn: 'Support', links: [
      { id: 'f-shipping', label: 'Shipping & Returns', href: '/support/shipping-returns' },
      { id: 'f-track',    label: 'Track Order',        href: '/support/track' },
      { id: 'f-contact',  label: 'Contact',            href: '/contact' },
    ] },
    { id: 'legal', heading: 'Legal', i18nKey: 'legal', i18nEn: 'Legal', links: [
      { id: 'f-privacy', label: 'Privacy', href: '/privacy' },
      { id: 'f-terms',   label: 'Terms',   href: '/terms' },
      { id: 'f-cookies', label: 'Cookies', href: '/cookies' },
    ] },
  ],
  social: [
    { id: 'instagram', platform: 'instagram', label: 'KVRN on Instagram', href: 'https://instagram.com/thekvrn' },
    { id: 'tiktok',    platform: 'tiktok',    label: 'KVRN on TikTok',    href: 'https://tiktok.com/@thekvrn' },
  ],
  copyrightHolder: 'KVRN',
  copyrightSuffix: '',
}

export const DEFAULT_ANNOUNCEMENT: AnnouncementSnapshot = {
  enabled: true,
  messages: [
    { id: 'm1', text: 'Complimentary U.S. shipping on orders over $150' },
    { id: 'm2', text: 'New arrivals available now' },
    { id: 'm3', text: 'Join the list for $10 off your first order' },
  ],
  startsAt: null,
  endsAt: null,
}

export const DEFAULT_ABOUT: AboutSnapshot = {
  heroTitle: 'About',
  brandEyebrow: 'The brand',
  lead: 'KVRN is built around weight, structure, and restraint.',
  brandParagraphs: [
    'Every piece starts from the fabric — not from a trend. We work with fleece heavy enough to hold its shape, cut to proportions that make sense without needing to be adjusted.',
    'There is no branding on the outside. No drawstrings to pull. No visible hardware unless it serves a purpose. The goal is a garment you stop thinking about because it works.',
  ],
  approachEyebrow: 'The approach',
  approach: [
    { id: 'weight',       title: 'Weight',       description: 'Dense enough to feel structural. GSM is a starting point, not a selling point.' },
    { id: 'construction', title: 'Construction', description: 'Every detail serves a purpose. What you see is what it does.' },
    { id: 'longevity',    title: 'Longevity',    description: 'Built to be worn daily without showing it. No decoration that fades.' },
    { id: 'restraint',    title: 'Restraint',    description: 'Nothing added that should not be there.' },
  ],
  ctaLabel: 'Shop the collection',
  ctaHref: '/shop',
  seo: { description: 'KVRN is built around weight, structure, and restraint. Quiet garments designed for daily wear.' },
}
/** The coded About page's <title> (the coded page uses 'About — KVRN'). */
export const ABOUT_CODED_TITLE = 'About — KVRN'

export const DEFAULT_CONTACT: ContactSnapshot = {
  heroTitle: 'Contact',
  intro: '',
  successTitle: 'Message sent.',
  successBody: 'We will respond within 1–2 business days.',
  supportHours: '',
  helpNote: '',
  seo: {},
}

export const DEFAULT_SIZE_GUIDE_PAGE: SupportPageSnapshot = {
  heroTitle: 'Size Guide',
  intro: 'All measurements refer to the garment, not body size. KVRN is designed oversized. Order your usual size for the intended silhouette. Size down if you prefer a slightly closer fit.',
  tip: { v: 1, blocks: [para('If you are between sizes, we recommend sizing down for a cleaner oversized fit. Questions about fit can be sent to [support@kvrn.shop](mailto:support@kvrn.shop).')] },
  links: [
    { id: 'hoodies', label: 'Shop Hoodies', href: '/shop?type=hoodies' },
    { id: 'sweatpants', label: 'Shop Sweatpants', href: '/shop?type=sweatpants' },
  ],
  seo: {},
}

/** The current hardcoded site metadata/org schema from app/layout.tsx. */
export const DEFAULT_GLOBAL_SEO: GlobalSeo = {
  siteName: 'KVRN',
  titleDefault: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
  titleTemplate: '%s | KVRN',
  description: 'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Double-layered hood. Concealed interior zippers. No drawstrings. Quiet luxury.',
  keywords: [
    'heavyweight hoodie', '400 gsm hoodie', '500 gsm hoodie',
    'oversized hoodie', 'quiet luxury', 'premium sweatpants',
    'french terry hoodie', 'cropped hoodie', 'luxury streetwear', 'KVRN',
  ],
  ogTitle: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants',
  ogDescription: 'Double-layered hood. Concealed zipper pockets. No drawstrings. 400–500 GSM fleece.',
  twitterTitle: 'KVRN — Heavyweight Oversized Fleece',
  twitterDescription: '400–500 GSM. Quiet luxury.',
  organization: {
    type: 'ClothingStore',
    name: 'KVRN',
    url: 'https://kvrn.shop',
    description: 'Premium heavyweight fleece. Oversized hoodies and sweatpants built for daily wear.',
    email: 'support@kvrn.shop',
    sameAs: ['https://instagram.com/thekvrn', 'https://tiktok.com/@thekvrn'],
    contactType: 'customer support',
    availableLanguage: 'English',
  },
  translations: {},
}
