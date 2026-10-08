// lib/content-localize.ts — turn (source snapshot + published translation rows) into localized
// variants WITHOUT ever presenting a fallback as translated. PURE.
//
// For one locale each translatable field resolves to:
//   translated  the published translation of the current source text
//   stale       a published translation written against OLDER source text (still shown, flagged)
//   fallback    no published translation: the English source is used and the variant says so
//   missing     the source itself is empty
// A variant's overall state is derived from its fields:
//   'translated'  every field translated (stale counts as 'stale' overall)
//   'partial'     some fields translated, the rest fall back to English
//   'fallback'    nothing translated — the page is English and must be labelled lang="en"

import { resolveFields, SOURCE_LOCALE, type TranslationRow } from './translations'
import { translatableFields, localizeSnapshot, type ContentKind } from './content-schemas'

export type VariantState = 'translated' | 'partial' | 'stale' | 'fallback'

export interface Variant<T> {
  locale: string
  data: T
  state: VariantState
  counts: { translated: number; stale: number; fallback: number }
}

type Row = Pick<TranslationRow, 'locale' | 'field' | 'value' | 'status' | 'source_hash'>

export function buildVariants<T>(
  kind: ContentKind, snapshot: T, rows: Row[], enabledLocales: string[],
): Record<string, Variant<T>> {
  const source = translatableFields(kind, snapshot)
  const out: Record<string, Variant<T>> = {
    [SOURCE_LOCALE]: { locale: SOURCE_LOCALE, data: snapshot, state: 'translated', counts: { translated: Object.keys(source).length, stale: 0, fallback: 0 } },
  }
  const byLocale = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.status !== 'published' || r.locale === SOURCE_LOCALE || !enabledLocales.includes(r.locale)) continue
    const a = byLocale.get(r.locale) ?? []; a.push(r); byLocale.set(r.locale, a)
  }
  for (const [locale, lrows] of byLocale) {
    const res = resolveFields(source, lrows, locale)
    const values: Record<string, string> = {}
    let translated = 0, stale = 0, fallback = 0
    for (const [field, r] of Object.entries(res)) {
      if (r.state === 'translated') { translated++; values[field] = r.value }
      else if (r.state === 'stale') { stale++; values[field] = r.value }
      else fallback++
    }
    if (translated + stale === 0) continue        // nothing usable: no variant → callers fall back to English
    const state: VariantState = fallback > 0 ? 'partial' : stale > 0 ? 'stale' : 'translated'
    out[locale] = { locale, data: localizeSnapshot(kind, snapshot, values), state, counts: { translated, stale, fallback } }
  }
  return out
}

/** Pick the variant for a requested locale; falls back to English and reports which locale it used. */
export function pickVariant<T>(variants: Record<string, Variant<T>>, locale: string | undefined): Variant<T> {
  return (locale && variants[locale]) || variants[SOURCE_LOCALE]
}
