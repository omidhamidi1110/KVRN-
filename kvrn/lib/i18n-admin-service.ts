// lib/i18n-admin-service.ts — Admin read/write of the language + currency settings
// (site_settings keys `i18n.config` and `i18n.fx`).
//
// Saves go through putSetting: optimistic revision + an admin_audit_logs row in the same statement.
// Validation is the same pure code the storefront reads with (lib/i18n/config, lib/i18n/fx), so
// Admin can never store something the storefront would reject, and an incomplete language cannot
// be enabled. The currency section is read-only about PAYABILITY: nothing here (or anywhere in
// Admin) can make a non-USD currency chargeable — see lib/i18n/currency-policy.ts.

import { getSetting, putSetting, SettingsStaleError } from './site-settings'
import { ContentError } from './content-service'
import { LOCALE_CODES, LOCALES, SOURCE_LOCALE, type Locale } from './i18n/locales'
import { MESSAGES, MESSAGE_KEYS, LOCALE_REVIEW, readyLocales, staticCompleteness } from './i18n/messages'
import { I18N_CONFIG_KEY, parseI18nConfig, validateI18nConfig, defaultI18nConfig } from './i18n/config'
import { FX_KEY, FX_STALE_AFTER_DAYS, FX_EXPIRED_AFTER_DAYS, parseFx, validateFx, fxAgeDays, fxStatus } from './i18n/fx'
import { CURRENCY_BLOCKERS, PAYABLE_AUDIT_PASSED, currencySupportMatrix } from './i18n/currency-policy'
import { summarizeCompleteness } from './translations'
import { translatableSource } from './product-model'
import { isFeatureEnabled } from './feature-flags'
import { __resetI18nSettingsCache } from './i18n/server'

type Sql = any

export interface LocaleRow {
  code: Locale
  label: string
  nativeLabel: string
  rtl: boolean
  enabled: boolean
  defaultCurrency: string
  /** Static (coded) wording completeness: every key present, non-empty and placeholder-faithful. */
  staticTotal: number
  staticPresent: number
  staticMissing: number
  staticPlaceholderIssues: number
  ready: boolean
  review: { status: string; note: string }
  /** Admin content (products etc.) translation summary for this locale. */
  cms: { translated: number; stale: number; missing: number; fields: number; products: number; publishedRows: number; draftRows: number }
}

export function createI18nAdminService(sql: Sql, deps: {
  now?: () => Date
  listProductSnapshots?: () => Promise<Array<{ productId: string; snapshot: any }>>
  flagOn?: () => boolean
} = {}) {
  const now = deps.now ?? (() => new Date())
  const flagOn = deps.flagOn ?? (() => isFeatureEnabled('MULTI_CURRENCY_CHECKOUT'))

  async function productSnapshots(): Promise<Array<{ productId: string; snapshot: any }>> {
    if (deps.listProductSnapshots) return deps.listProductSnapshots()
    try {
      const { listPublishedProducts } = await import('./product-public')
      return (await listPublishedProducts()).map(h => ({ productId: h.productId, snapshot: h.snapshot }))
    } catch { return [] }
  }

  async function cmsSummary(locales: readonly Locale[]) {
    const out: Record<string, LocaleRow['cms']> = {}
    for (const l of locales) out[l] = { translated: 0, stale: 0, missing: 0, fields: 0, products: 0, publishedRows: 0, draftRows: 0 }
    let rows: Array<{ entity_type: string; entity_id: string; locale: string; field: string; value: string; status: string; source_hash: string | null }> = []
    try {
      rows = await sql`SELECT entity_type, entity_id, locale, field, value, status, source_hash FROM content_translations` as any[]
    } catch { /* table missing: nothing translated */ }
    for (const r of rows) {
      const o = out[r.locale]; if (!o) continue
      if (r.status === 'published') o.publishedRows++; else o.draftRows++
    }
    // Per-product completeness uses the same function the product editor uses.
    const snaps = await productSnapshots()
    for (const s of snaps) {
      const src = translatableSource(s.snapshot)
      const byLocale: Record<string, any[]> = {}
      for (const r of rows) if (r.entity_type === 'product' && r.entity_id === s.productId && !r.field.startsWith('bundle.')) (byLocale[r.locale] ??= []).push(r)
      for (const c of summarizeCompleteness(src, byLocale, [...locales])) {
        const o = out[c.locale]; if (!o) continue
        o.products++; o.translated += c.translated; o.stale += c.stale; o.missing += c.missing; o.fields += c.total
      }
    }
    return out
  }

  async function get() {
    const t = now()
    const ready = readyLocales()
    const [cfgRow, fxRow] = await Promise.all([
      getSetting<unknown>(sql, I18N_CONFIG_KEY, null),
      getSetting<unknown>(sql, FX_KEY, null),
    ])
    const config = parseI18nConfig(cfgRow.value, ready)
    const fx = parseFx(fxRow.value, t)
    const cms = await cmsSummary(LOCALE_CODES)
    const locales: LocaleRow[] = LOCALE_CODES.map(code => {
      const m = LOCALES[code]; const sc = staticCompleteness(code)
      return {
        code, label: m.label, nativeLabel: m.nativeLabel, rtl: m.rtl,
        enabled: config.enabledLocales.includes(code),
        defaultCurrency: config.defaultCurrencyByLocale[code],
        staticTotal: sc.total, staticPresent: sc.present, staticMissing: sc.missing.length + sc.empty.length,
        staticPlaceholderIssues: sc.placeholderMismatch.length, ready: sc.complete,
        review: LOCALE_REVIEW[code], cms: cms[code],
      }
    })
    return {
      config: { value: config, revision: cfgRow.revision, stored: cfgRow.value !== null },
      fx: {
        value: fx, revision: fxRow.revision,
        status: fxStatus(fx, t), ageDays: fxAgeDays(fx, t),
        staleAfterDays: FX_STALE_AFTER_DAYS, expiredAfterDays: FX_EXPIRED_AFTER_DAYS,
      },
      locales,
      sourceLocale: SOURCE_LOCALE,
      messageKeyCount: MESSAGE_KEYS.length,
      currencies: currencySupportMatrix(fx, config.enabledCurrencies, t),
      payable: { auditPassed: [...PAYABLE_AUDIT_PASSED], multiCurrencyFlag: flagOn(), blockers: CURRENCY_BLOCKERS },
    }
  }

  function stale(e: unknown): never {
    if (e instanceof SettingsStaleError) throw new ContentError('conflict', 'This was changed by someone else. Reload and try again.')
    throw e
  }

  async function putConfig(input: unknown, expectedRevision: number, actor: string) {
    const v = validateI18nConfig(input, readyLocales())
    if (!v.ok) throw new ContentError('invalid', 'Some settings need attention.', v.errors)
    let revision: number
    try { revision = (await putSetting(sql, I18N_CONFIG_KEY, v.value, expectedRevision, actor)).revision } catch (e) { stale(e) }
    __resetI18nSettingsCache()
    return { data: { revision: revision!, value: v.value } }
  }

  /** Save the display-only exchange rates. `clear` removes them (everything shows USD again). */
  async function putFx(input: unknown, expectedRevision: number, actor: string) {
    const t = now()
    if (input && typeof input === 'object' && (input as any).clear === true) {
      let revision: number
      try { revision = (await putSetting(sql, FX_KEY, {}, expectedRevision, actor)).revision } catch (e) { stale(e) }
      __resetI18nSettingsCache()
      return { data: { revision: revision!, value: null } }
    }
    const v = validateFx(input, t)
    if (!v.ok) throw new ContentError('invalid', 'Some rates need attention.', v.errors)
    let revision: number
    try { revision = (await putSetting(sql, FX_KEY, v.value, expectedRevision, actor)).revision } catch (e) { stale(e) }
    __resetI18nSettingsCache()
    return { data: { revision: revision!, value: v.value } }
  }

  return { get, putConfig, putFx }
}

export type I18nAdminService = ReturnType<typeof createI18nAdminService>
export { defaultI18nConfig }
