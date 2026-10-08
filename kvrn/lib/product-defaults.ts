// lib/product-defaults.ts — global product defaults (site_settings key `product.defaults`).
//
// Products use the GLOBAL Shipping & Returns text unless they explicitly override it, so a
// policy wording change is made once. The fallback below is the exact wording the storefront
// has always shown, so an unconfigured install renders identically to the coded template.
import { getSetting, putSetting } from './site-settings'

export const PRODUCT_DEFAULTS_KEY = 'product.defaults'

export interface ProductDefaults {
  shippingReturns: { lines: string[]; linkLabel: string; href: string }
}

export const FALLBACK_PRODUCT_DEFAULTS: ProductDefaults = {
  shippingReturns: {
    lines: [
      'Orders processed within 1–3 business days.',
      'US: 2–7 days. International: 5–14+ days.',
      'Returns within 14 days, unworn and in original condition.',
    ],
    linkLabel: 'Full policy →',
    href: '/support/shipping-returns',
  },
}

export const GLOBAL_SIZE_GUIDE_HREF = '/support/size-guide'

const HREF_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export type DefaultsParse = { ok: true; value: ProductDefaults } | { ok: false; errors: string[] }

/** Strict parser for admin input. */
export function parseProductDefaults(raw: unknown): DefaultsParse {
  const errors: string[] = []
  if (!isObj(raw) || !isObj(raw.shippingReturns)) return { ok: false, errors: ['Shipping & Returns is required.'] }
  const sr = raw.shippingReturns
  const lines = Array.isArray(sr.lines) ? sr.lines : (errors.push('Lines must be a list.'), [])
  if (lines.length > 8) errors.push('Use at most 8 lines.')
  const clean: string[] = []
  lines.slice(0, 8).forEach((l, i) => {
    if (typeof l !== 'string') { errors.push(`Line ${i + 1} must be text.`); return }
    const t = l.trim()
    if (t.length > 300) errors.push(`Line ${i + 1} is longer than 300 characters.`)
    if (t) clean.push(t)
  })
  const linkLabel = typeof sr.linkLabel === 'string' ? sr.linkLabel.trim() : ''
  const href = typeof sr.href === 'string' ? sr.href.trim() : ''
  if (linkLabel.length > 60) errors.push('Link label is longer than 60 characters.')
  if (href && (href.startsWith('//') || href.includes('..') || !HREF_RE.test(href))) errors.push('Link must be a path on this site, like /support/shipping-returns.')
  if (!clean.length) errors.push('Add at least one line.')
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { shippingReturns: { lines: clean, linkLabel: linkLabel || FALLBACK_PRODUCT_DEFAULTS.shippingReturns.linkLabel, href: href || FALLBACK_PRODUCT_DEFAULTS.shippingReturns.href } } }
}

/** Defensive read: a missing/invalid setting yields the fallback, never an error. */
export async function loadProductDefaults(sql: any): Promise<{ value: ProductDefaults; revision: number }> {
  try {
    const s = await getSetting<unknown>(sql, PRODUCT_DEFAULTS_KEY, null)
    const p = s.value === null ? null : parseProductDefaults(s.value)
    return { value: p && p.ok ? p.value : FALLBACK_PRODUCT_DEFAULTS, revision: s.revision }
  } catch {
    return { value: FALLBACK_PRODUCT_DEFAULTS, revision: 0 }
  }
}

export async function saveProductDefaults(sql: any, raw: unknown, expectedRevision: number, actor: string) {
  const p = parseProductDefaults(raw)
  if (!p.ok) return { ok: false as const, errors: p.errors }
  const r = await putSetting(sql, PRODUCT_DEFAULTS_KEY, p.value, expectedRevision, actor)
  return { ok: true as const, revision: r.revision, value: p.value }
}
