// lib/consent-effective.ts — the ONE rule for "may analytics run right now?".
//
// Pure and dependency-free (no React, no imports), so the cookie-preferences context, the
// first-party funnel tracker and the GA4 client can all share it without a circular import.
// It adds NO second consent store: the stored preference (KVRN's existing cookie preferences) is
// passed in; this only combines it with the browser-level opt-out signals.
//
//   effective analytics consent = stored preference is exactly true
//                                 AND Do Not Track is not '1'
//                                 AND Global Privacy Control is not true
//
// A stored "yes" can therefore never switch analytics on while the browser is signalling an
// opt-out, and an opt-out that appears later (after GA was already running) turns it off.

export interface BrowserPrivacySignals {
  doNotTrack?: unknown
  globalPrivacyControl?: unknown
}

/** True when the browser asks not to be tracked (DNT: 1) or signals GPC. */
export function browserOptOutActive(nav?: BrowserPrivacySignals | null): boolean {
  try {
    const n = nav === undefined ? (typeof window === 'undefined' ? null : window.navigator) : nav
    if (!n) return false
    return (n as BrowserPrivacySignals).doNotTrack === '1' || (n as BrowserPrivacySignals).globalPrivacyControl === true
  } catch { return false }
}

/** The stored analytics preference combined with the browser opt-out signals. Strictly boolean. */
export function effectiveAnalyticsConsent(prefAnalytics: unknown, nav?: BrowserPrivacySignals | null): boolean {
  return prefAnalytics === true && !browserOptOutActive(nav)
}

export interface GtagConsentUpdate {
  analytics_storage: 'granted' | 'denied'
  ad_storage: 'denied'
  ad_user_data: 'denied'
  ad_personalization: 'denied'
  personalization_storage: 'granted' | 'denied'
  functionality_storage: 'granted'
}

/**
 * The Consent Mode update the cookie-preferences UI sends to gtag when preferences are saved/loaded.
 *   * analytics_storage follows EFFECTIVE consent: a stored "yes" while DNT/GPC is blocking analytics
 *     is 'denied', never 'granted'.
 *   * KVRN runs no ads and no Google advertising features, so every advertising signal is 'denied'
 *     whatever the "Targeted Advertising" toggle says (GA is analytics-only).
 *   * personalization_storage / functionality_storage keep their previous behaviour.
 */
export function buildGtagConsentUpdate(
  prefs: { analytics?: unknown; personalization?: unknown },
  nav?: BrowserPrivacySignals | null,
): GtagConsentUpdate {
  return {
    analytics_storage: effectiveAnalyticsConsent(prefs.analytics, nav) ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    personalization_storage: prefs.personalization ? 'granted' : 'denied',
    functionality_storage: 'granted',
  }
}
