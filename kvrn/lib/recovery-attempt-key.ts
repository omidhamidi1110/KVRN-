// lib/recovery-attempt-key.ts
//
// Reload-safe recovery-collection idempotency key.
//
// Final5. Component state alone does not survive a page reload, so a lost
// response followed by an ordinary reload used to mint a brand-new key and
// let the retry through as an unrelated request. sessionStorage persists
// across that reload; the SAME unchanged payload therefore reuses the SAME
// key, while a CHANGED payload (the operator edited the amount before
// reloading) deliberately mints a new one — that is a genuinely new attempt,
// and the server fails closed if a key is ever reused for a different
// payload (collect_affiliate_recovery's IDEMPOTENCY_CONFLICT).
//
// Kept in its own module, with no React import, so this logic is testable in
// plain Node without a DOM.
const RECOVERY_ATTEMPT_KEY_PREFIX = 'kvrn:recovery:collect:'

/** Canonical fingerprint of a collection ATTEMPT's payload. */
export function collectionAttemptFingerprint(
  amountCents: number, date: string, method: string, reference: string,
): string {
  return JSON.stringify({
    amountCents,
    date: date || null,
    method: method || null,
    reference: reference || null,
  })
}

/**
 * Returns the durable idempotency key for this commission's in-flight
 * collection attempt, minting and persisting a new one only when there is no
 * stored attempt or the stored attempt's payload no longer matches.
 */
export function readOrCreateAttemptKey(commissionId: string, fingerprint: string): string {
  const storageKey = RECOVERY_ATTEMPT_KEY_PREFIX + commissionId
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.fingerprint === fingerprint && typeof parsed.key === 'string') {
        return parsed.key
      }
    }
  } catch {
    // Storage unavailable (private mode, blocked site data, etc). Fall through
    // to an attempt key that is at least correct for THIS page load.
  }
  const key = `collect:${commissionId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ key, fingerprint }))
  } catch {
    // Best effort only: an unpersisted key still works for this page load: it
    // simply will not survive a reload, which is the pre-Final5 behaviour.
  }
  return key
}

/** Retire the stored attempt only after a CONFIRMED success. */
export function clearAttemptKey(commissionId: string) {
  try { sessionStorage.removeItem(RECOVERY_ATTEMPT_KEY_PREFIX + commissionId) } catch {
    // Nothing to do — a failed removal just leaves a stale, harmless entry.
  }
}
