// lib/sms-signup.ts — the manual SMS sign-up request and its analytics lifecycle, as a pure-ish
// function (no React, no storage) so the exact event sequence is unit-testable.
//
// Lifecycle (canonical SmsAnalyticsEvent names, lib/analytics.ts):
//   request starts (validation already passed)          -> sms_manual_submit
//   server answered 2xx with { success: true }          -> sms_signup_success
//   server answered an error / success:false / network
//   failure / unparseable response                      -> sms_signup_error
// `track` is the consent-gated GA wrapper (trackSmsEvent): it carries ONLY the event name and the
// fixed event_category — never the phone number, the discount code or anything else from this flow.
import type { SmsAnalyticsEvent } from './analytics'

export type SmsSignupResult =
  | { ok: true; discountCode: string | null }
  | { ok: false; error: string }

export async function submitSmsSignup(
  phone: string,
  source: string,
  deps: { track: (e: SmsAnalyticsEvent) => void; fetchImpl?: typeof fetch },
): Promise<SmsSignupResult> {
  const doFetch = deps.fetchImpl ?? fetch
  deps.track('sms_manual_submit')
  try {
    const res = await doFetch('/api/sms/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone.trim(), source }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) {
      deps.track('sms_signup_error')
      return { ok: false, error: data.error ?? 'Could not sign up. Please try again.' }
    }
    deps.track('sms_signup_success')
    return { ok: true, discountCode: data.discountCode ? String(data.discountCode) : null }
  } catch {
    deps.track('sms_signup_error')
    return { ok: false, error: 'Network error. Please try again.' }
  }
}
