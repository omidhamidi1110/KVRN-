// lib/phone.ts — Phone number normalization to E.164
// Server-only. Never expose raw phone numbers to logs unnecessarily.

/**
 * Normalize a phone number string to E.164 format.
 * Supports common US/CA formats (country code +1).
 * Returns null if the number cannot be safely normalized.
 *
 * Does NOT guess country codes for ambiguous international inputs —
 * use the explicit + prefix for non-US/CA numbers.
 *
 * Accepted US/CA examples:
 *   (657) 555-1234   → +16575551234
 *   657-555-1234     → +16575551234
 *   6575551234       → +16575551234
 *   16575551234      → +16575551234
 *   +16575551234     → +16575551234   (already E.164)
 *
 * Accepted international (explicit + prefix required):
 *   +447911123456    → +447911123456
 */
export function normalizePhoneE164(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null

  // Strip formatting characters: spaces, dashes, parens, dots
  const stripped = raw.trim().replace(/[\s\-\(\)\.]/g, '')

  // Reject if contains any non-digit after stripping (except leading +)
  const body = stripped.startsWith('+') ? stripped.slice(1) : stripped
  if (!/^\d+$/.test(body)) return null

  // Already E.164 with + prefix
  if (stripped.startsWith('+')) {
    // Must be 7–15 digits (ITU-T E.164: max 15 digits total)
    if (body.length >= 7 && body.length <= 15) return stripped
    return null
  }

  // 11 digits starting with 1 → US/CA with country code
  if (/^1\d{10}$/.test(stripped)) return '+' + stripped

  // 10 digits → US/CA assumed (do not guess other country codes)
  if (/^\d{10}$/.test(stripped)) return '+1' + stripped

  return null  // cannot safely normalize
}

/** Return true if the string looks like a valid E.164 number. */
export function isValidE164(phone: string): boolean {
  return /^\+\d{7,15}$/.test(phone)
}

/** Mask a phone for safe display: +1*****1234 */
export function maskPhone(e164: string): string {
  if (e164.length < 4) return '***'
  const last4 = e164.slice(-4)
  const prefix = e164.startsWith('+1') ? '+1' : e164.slice(0, 2)
  return `${prefix}*****${last4}`
}
