/** Public email-list enrollment must be affirmative and never imply SMS consent.
 * Source is an audit hint, not independent proof that the human controls email.
 * Unsolicited marketing dispatch stays disabled until release approval.
 */
export type PublicEmailSource = 'homepage' | 'footer' | 'waitlist'
export type PublicEmailConsentResult =
  | { ok: true; source: PublicEmailSource }
  | { ok: false; error: string }
const PUBLIC_SOURCES: ReadonlySet<string> = new Set(['homepage', 'footer', 'waitlist'])

export function validatePublicEmailConsent(body: Record<string, unknown>, fallback: PublicEmailSource): PublicEmailConsentResult {
  // Do not silently turn a phone-number form, checkout, or admin record into email consent.
  if (body.phone != null || body.smsConsent != null || body.smsMarketingConsent != null) {
    return { ok: false, error: 'Email and SMS marketing enrollment are separate.' }
  }
  if (body.emailMarketingConsent !== true) {
    return { ok: false, error: 'Please confirm that you want KVRN marketing emails.' }
  }
  if (body.source !== undefined && (typeof body.source !== 'string' || !PUBLIC_SOURCES.has(body.source))) {
    return { ok: false, error: 'Invalid signup source.' }
  }
  // A browser may self-report "footer" or "homepage", but that is not
  // verifiable consent provenance. Record only the server-route context; a
  // client-supplied hint must never become purported audit evidence.
  return { ok: true, source: fallback }
}
