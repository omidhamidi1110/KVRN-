// lib/translations.ts — per-field content translations with a real completeness status.
//
// A missing translation is MISSING, never silently presented as complete. Reading with
// `resolveFields` tells the caller, per field, whether the value came from the requested
// locale ('translated'), fell back to the source language ('fallback') or is absent
// ('missing') so the storefront can render the fallback to avoid a crash while Admin
// still shows the translation as incomplete.

type Sql = any

export const SOURCE_LOCALE = 'en'

export type TranslationStatus = 'draft' | 'needs_review' | 'published'

/** Stable hash of the source text a translation was written against (FNV-1a 32-bit, hex). */
export function sourceHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export interface TranslationRow {
  entity_type: string; entity_id: string; locale: string; field: string
  value: string; status: TranslationStatus; source_hash: string | null
  machine_generated: boolean; updated_at: string
}

export async function upsertTranslation(sql: Sql, t: {
  entityType: string; entityId: string; locale: string; field: string; value: string
  sourceText?: string; status?: TranslationStatus; machineGenerated?: boolean; actor: string
}): Promise<void> {
  if (t.locale === SOURCE_LOCALE) throw new Error('The source locale is not a translation.')
  const machine = !!t.machineGenerated
  const status: TranslationStatus = machine ? 'draft' : (t.status ?? 'draft')   // machine text can never publish
  await sql`
    INSERT INTO content_translations
      (entity_type, entity_id, locale, field, value, status, source_hash, machine_generated, updated_by, published_at)
    VALUES
      (${t.entityType}, ${t.entityId}, ${t.locale}, ${t.field}, ${t.value}, ${status},
       ${t.sourceText !== undefined ? sourceHash(t.sourceText) : null}, ${machine}, ${t.actor},
       ${status === 'published' ? new Date().toISOString() : null})
    ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE
      SET value = EXCLUDED.value, status = EXCLUDED.status, source_hash = EXCLUDED.source_hash,
          machine_generated = EXCLUDED.machine_generated, updated_by = EXCLUDED.updated_by,
          updated_at = NOW(), published_at = EXCLUDED.published_at`
}

export type FieldResolution = { value: string; state: 'translated' | 'fallback' | 'missing' | 'stale' }

/**
 * Resolve fields for a locale. Only 'published' translations are used on the storefront.
 * `source` is the source-language text per field (used for the fallback and staleness).
 */
export function resolveFields(
  source: Record<string, string | null | undefined>,
  rows: Array<Pick<TranslationRow, 'field' | 'value' | 'status' | 'source_hash'>>,
  locale: string,
): Record<string, FieldResolution> {
  const out: Record<string, FieldResolution> = {}
  const byField = new Map(rows.map(r => [r.field, r]))
  for (const [field, src] of Object.entries(source)) {
    const text = src ?? ''
    if (locale === SOURCE_LOCALE) { out[field] = { value: text, state: text ? 'translated' : 'missing' }; continue }
    const r = byField.get(field)
    if (r && r.status === 'published' && r.value) {
      const stale = r.source_hash !== null && r.source_hash !== sourceHash(text)
      out[field] = { value: r.value, state: stale ? 'stale' : 'translated' }
    } else {
      out[field] = { value: text, state: text ? 'fallback' : 'missing' }
    }
  }
  return out
}

export async function loadTranslations(sql: Sql, entityType: string, entityId: string, locale: string) {
  return await sql`
    SELECT entity_type, entity_id, locale, field, value, status, source_hash, machine_generated, updated_at
      FROM content_translations WHERE entity_type=${entityType} AND entity_id=${entityId} AND locale=${locale}` as TranslationRow[]
}

export interface CompletenessSummary { locale: string; total: number; translated: number; stale: number; missing: number; complete: boolean }

/** Per-locale completeness for one entity (Admin indicator). */
export function summarizeCompleteness(
  source: Record<string, string | null | undefined>,
  rowsByLocale: Record<string, Array<Pick<TranslationRow, 'field' | 'value' | 'status' | 'source_hash'>>>,
  locales: string[],
): CompletenessSummary[] {
  const fields = Object.entries(source).filter(([, v]) => (v ?? '').trim() !== '')
  return locales.filter(l => l !== SOURCE_LOCALE).map(locale => {
    const res = resolveFields(Object.fromEntries(fields), rowsByLocale[locale] ?? [], locale)
    let translated = 0, stale = 0, missing = 0
    for (const r of Object.values(res)) {
      if (r.state === 'translated') translated++
      else if (r.state === 'stale') stale++
      else missing++
    }
    return { locale, total: fields.length, translated, stale, missing,
             complete: fields.length > 0 && translated === fields.length }
  })
}
