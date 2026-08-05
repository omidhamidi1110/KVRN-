// lib/checkout-validation.ts — server-side checkout input validation
// Imported by the checkout route and its tests. Never duplicated.

export const FIELD_MAX = {
  email:    254,
  name:      80,
  phone:     30,
  address:  200,
  city:      80,
  zip:       10,
  method:    10,
  country:    2,
  state:      2,
} as const

export type FieldResult =
  | { ok: true;  value: string }
  | { ok: false; error: string }

/**
 * Required string field: trims, rejects null/undefined/non-string/empty/overlong.
 * Never truncates.
 */
export function requiredStringField(v: unknown, max: number, label: string): FieldResult {
  if (v === null || v === undefined) {
    return { ok: false, error: `${label} is required.` }
  }
  if (typeof v !== 'string') {
    return { ok: false, error: `${label} must be a string.` }
  }
  const trimmed = v.trim()
  if (!trimmed) {
    return { ok: false, error: `${label} is required.` }
  }
  if (trimmed.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer.` }
  }
  return { ok: true, value: trimmed }
}

/**
 * Optional string field: absent/null/undefined/empty → { ok: true, value: '' }.
 * Only rejects overlong non-empty strings or non-string supplied values.
 * Never truncates.
 */
export function optionalStringField(v: unknown, max: number, label: string): FieldResult {
  if (v === null || v === undefined) return { ok: true, value: '' }
  if (typeof v !== 'string') {
    return { ok: false, error: `${label} must be a string when provided.` }
  }
  const trimmed = v.trim()
  if (!trimmed) return { ok: true, value: '' }
  if (trimmed.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer.` }
  }
  return { ok: true, value: trimmed }
}
