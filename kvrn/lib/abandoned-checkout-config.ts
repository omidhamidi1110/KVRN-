// lib/abandoned-checkout-config.ts — the `abandoned.config` setting (site_settings) + constants.
// Pure: no database, no environment. The feature FLAG (ABANDONED_CHECKOUT_EMAILS) is separate and
// always wins: with the flag OFF nothing is sent no matter what this config says.

export const ABANDONED_CONFIG_KEY = 'abandoned.config'

export type ConsentMode = 'require_opt_in' | 'cart_reminder_no_consent'
export const CONSENT_MODES: ConsentMode[] = ['require_opt_in', 'cart_reminder_no_consent']

export interface AbandonedConfig {
  /** Global on/off for sending (in addition to the feature flag). */
  enabled: boolean
  /** Minutes after abandonment before the single email is queued. */
  delay_minutes: number
  /** Always 1. Kept as a field so the stored shape documents the policy. */
  max_emails: 1
  consent_mode: ConsentMode
  /** How long after abandonment the email may be sent and the link works. */
  window_hours: number
}

export const DEFAULT_ABANDONED_CONFIG: AbandonedConfig = {
  enabled: true,
  delay_minutes: 60,
  max_emails: 1,
  consent_mode: 'require_opt_in',
  window_hours: 72,
}

export const DELAY_MINUTES_RANGE = { min: 15, max: 1440 } as const
export const WINDOW_HOURS_RANGE = { min: 24, max: 168 } as const

// ── Fixed delivery policy (not configurable: restraint is the point) ─────────
/** Provider attempts per email: the first send plus two retries. */
export const MAX_SEND_ATTEMPTS = 3
/** A manual retry grants exactly ONE extra attempt, once per row. */
export const MAX_MANUAL_RETRIES = 1
/** Back-off after a failed attempt N (index N-1). */
export const RETRY_BACKOFF_MINUTES = [15, 60]
/** A claimed-but-unfinished send becomes claimable again after this long (crashed worker). */
export const SEND_LEASE_MINUTES = 10
/** Wait this long past the reservation's end before calling a checkout abandoned. */
export const ABANDON_GRACE_MINUTES = 2
/** At most one recovery email per address in this many days, across all carts. */
export const PER_EMAIL_COOLDOWN_DAYS = 7
/** Unsubscribe links stay valid much longer than recovery links. */
export const UNSUBSCRIBE_LINK_DAYS = 180
export const SWEEP_BATCH = 50

export type ConfigValidation =
  | { ok: true; value: AbandonedConfig }
  | { ok: false; errors: Record<string, string> }

/** Strict validation for Admin writes. Unknown keys are rejected. */
export function validateAbandonedConfig(input: unknown): ConfigValidation {
  const errors: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _: 'Settings must be an object.' } }
  }
  const o = input as Record<string, unknown>
  const allowed = new Set(['enabled', 'delay_minutes', 'max_emails', 'consent_mode', 'window_hours'])
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors[k] = 'Unknown setting.'

  if (typeof o.enabled !== 'boolean') errors.enabled = 'Choose on or off.'
  const dm = o.delay_minutes
  if (typeof dm !== 'number' || !Number.isInteger(dm) || dm < DELAY_MINUTES_RANGE.min || dm > DELAY_MINUTES_RANGE.max) {
    errors.delay_minutes = `Enter ${DELAY_MINUTES_RANGE.min}–${DELAY_MINUTES_RANGE.max} minutes.`
  }
  if (o.max_emails !== 1) errors.max_emails = 'Only one recovery email is supported.'
  if (typeof o.consent_mode !== 'string' || !CONSENT_MODES.includes(o.consent_mode as ConsentMode)) {
    errors.consent_mode = 'Choose a consent mode.'
  }
  const wh = o.window_hours
  if (typeof wh !== 'number' || !Number.isInteger(wh) || wh < WINDOW_HOURS_RANGE.min || wh > WINDOW_HOURS_RANGE.max) {
    errors.window_hours = `Enter ${WINDOW_HOURS_RANGE.min}–${WINDOW_HOURS_RANGE.max} hours.`
  }
  if (typeof dm === 'number' && typeof wh === 'number' && Number.isFinite(dm) && Number.isFinite(wh)
      && !errors.delay_minutes && !errors.window_hours && dm >= wh * 60) {
    errors.window_hours = 'The window must be longer than the delay.'
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      enabled: o.enabled as boolean,
      delay_minutes: dm as number,
      max_emails: 1,
      consent_mode: o.consent_mode as ConsentMode,
      window_hours: wh as number,
    },
  }
}

/**
 * Read-side normalisation. A missing or damaged stored value NEVER widens behaviour: every
 * field that is not valid falls back to its safe default (opt-in required, one email).
 */
export function normalizeAbandonedConfig(raw: unknown): AbandonedConfig {
  const base = { ...DEFAULT_ABANDONED_CONFIG }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const o = raw as Record<string, unknown>
  const out: AbandonedConfig = { ...base }
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.delay_minutes === 'number' && Number.isInteger(o.delay_minutes)
      && o.delay_minutes >= DELAY_MINUTES_RANGE.min && o.delay_minutes <= DELAY_MINUTES_RANGE.max) {
    out.delay_minutes = o.delay_minutes
  }
  if (typeof o.consent_mode === 'string' && CONSENT_MODES.includes(o.consent_mode as ConsentMode)) {
    out.consent_mode = o.consent_mode as ConsentMode
  }
  if (typeof o.window_hours === 'number' && Number.isInteger(o.window_hours)
      && o.window_hours >= WINDOW_HOURS_RANGE.min && o.window_hours <= WINDOW_HOURS_RANGE.max) {
    out.window_hours = o.window_hours
  }
  if (out.delay_minutes >= out.window_hours * 60) {
    out.delay_minutes = DEFAULT_ABANDONED_CONFIG.delay_minutes
    out.window_hours = DEFAULT_ABANDONED_CONFIG.window_hours
  }
  return out
}

// ── Consent decision (pure) ─────────────────────────────────────────────────

export type SubscriberStatus = 'subscribed' | 'unsubscribed' | null

export interface ConsentFacts {
  /** marketing_subscribers.status for this address (null = no record). */
  subscriberStatus: SubscriberStatus
  /** When the subscriber last consented (ISO) — used to let a LATER opt-in lift a suppression. */
  consentedAt?: string | null
  /** When this address used a recovery-email unsubscribe link (ISO), if it did. */
  suppressedAt?: string | null
}

export type ConsentDecision =
  | { ok: true }
  | { ok: false; reason: 'suppressed' | 'no_consent' }

/**
 * May a recovery email go to this address under the configured mode?
 *
 *   require_opt_in            only an existing marketing opt-in ('subscribed')
 *   cart_reminder_no_consent  also addresses with no record (the owner's legal decision)
 *
 * In EVERY mode an address that unsubscribed (marketing_subscribers.status='unsubscribed') or
 * used our unsubscribe link is excluded. A recovery-link suppression is lifted only by a LATER
 * explicit re-subscribe.
 */
export function decideConsent(mode: ConsentMode, f: ConsentFacts): ConsentDecision {
  if (f.subscriberStatus === 'unsubscribed') return { ok: false, reason: 'suppressed' }
  if (f.suppressedAt) {
    const reSubscribedLater = f.subscriberStatus === 'subscribed' && !!f.consentedAt
      && new Date(f.consentedAt).getTime() > new Date(f.suppressedAt).getTime()
    if (!reSubscribedLater) return { ok: false, reason: 'suppressed' }
  }
  if (mode === 'require_opt_in' && f.subscriberStatus !== 'subscribed') {
    return { ok: false, reason: 'no_consent' }
  }
  return { ok: true }
}

/**
 * Click tracking only where an explicit opt-in exists. A cart reminder sent WITHOUT consent is
 * never tracked for opens or clicks (no pixel; no click timestamps).
 */
export function mayTrackClicks(f: Pick<ConsentFacts, 'subscriberStatus'>): boolean {
  return f.subscriberStatus === 'subscribed'
}
