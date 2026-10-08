// lib/content-locales.ts — which storefront locales exist, read defensively.
//
// The enabled-locale list lives in site_settings key `i18n.config` (`enabledLocales`, managed in
// Admin > Content > Languages & currency; see lib/i18n/config.ts). When it is absent the 10 locale
// codes the storefront ships are used. English is the source locale and is always first.

import { SOURCE_LOCALE } from './translations'

export const DEFAULT_LOCALES: readonly string[] = ['en', 'es', 'fr', 'ar', 'zh', 'hi', 'pt', 'de', 'ja', 'ko']
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

/** Accepts ["en","es"], [{code:"es"}], {enabled:[...]} or {locales:[...]}; anything else → defaults. */
export function parseEnabledLocales(value: unknown): string[] {
  let arr: unknown = value
  if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
    const o = arr as Record<string, unknown>
    arr = o.enabled ?? o.locales ?? o.codes
  }
  if (!Array.isArray(arr)) return [...DEFAULT_LOCALES]
  const out: string[] = []
  for (const x of arr) {
    const code = typeof x === 'string' ? x : (x && typeof x === 'object' ? (x as any).code ?? (x as any).locale : undefined)
    if (typeof code === 'string' && LOCALE_RE.test(code) && !out.includes(code)) out.push(code)
  }
  if (!out.length) return [...DEFAULT_LOCALES]
  return [SOURCE_LOCALE, ...out.filter(l => l !== SOURCE_LOCALE)]
}

export async function getEnabledLocales(sql: any): Promise<string[]> {
  try {
    // The Admin "Languages & currency" setting (`i18n.config`) is the source of truth; the older
    // `i18n.locales` list is read only when it does not exist.
    const rows = await sql`SELECT key, value FROM site_settings WHERE key IN ('i18n.config', 'i18n.locales')` as any[]
    const cfg = rows.find(r => r.key === 'i18n.config')?.value
    const enabled = cfg && typeof cfg === 'object' && Array.isArray((cfg as any).enabledLocales) ? (cfg as any).enabledLocales : null
    if (enabled) return parseEnabledLocales(enabled)
    return parseEnabledLocales(rows.find(r => r.key === 'i18n.locales')?.value)
  } catch {
    return [...DEFAULT_LOCALES]
  }
}

export const isValidLocale = (l: unknown): l is string => typeof l === 'string' && LOCALE_RE.test(l)
