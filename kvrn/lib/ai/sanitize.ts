/**
 * External/customer/web content is untrusted data. These helpers minimize PII/secrets
 * before content is handed to a model and make prompt boundaries explicit.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9._-]{12,}\b/gi, '[REDACTED_SECRET]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]'],
  [/\b(?:password|passwd|secret|api[_ -]?key)\s*[:=]\s*[^\s,;]{4,}/gi, '[REDACTED_SECRET_FIELD]'],
]

export function sanitizeExternalText(value: unknown, maxChars = 6000): string {
  let text = typeof value === 'string' ? value : String(value ?? '')
  // Remove control characters other than common whitespace, normalize line endings and excessive whitespace.
  text = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  // Minimize directly identifying values. Exact values remain in canonical KVRN data, not the model prompt.
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
  text = text.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[PHONE_REDACTED]')
  // Long numeric strings are commonly order/account/tracking identifiers; the model only needs their existence.
  text = text.replace(/\b\d{8,}\b/g, '[LONG_ID_REDACTED]')
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim()
  return text.slice(0, Math.max(0, maxChars))
}

export function externalContentBlock(label: string, value: unknown, maxChars = 6000): string {
  const safeLabel = String(label || 'external_content').replace(/[^a-z0-9_-]/gi, '_').slice(0, 48)
  // Prevent untrusted text from forging/closing the structural delimiter itself.
  // The semantic text remains readable to the model, but literal markup is inert.
  const text = sanitizeExternalText(value, maxChars)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<${safeLabel}>\n${text}\n</${safeLabel}>`
}

export function parseStrictJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const attempts = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* try next shape */ }
  }
  return null
}

export function safeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = typeof value === 'string' ? value : ''
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

export function boundedConfidence(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}
