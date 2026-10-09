// lib/abandoned-checkout-runtime.ts — production wiring (real Neon `sql`, real discounts,
// real marketing-unsubscribe). Routes import from here; tests build their own services with
// createAbandonedCheckoutService(testSql, …) instead, so this file is never loaded by them.

import { sql } from './db'
import { createAbandonedCheckoutService } from './abandoned-checkout'
import { createResumeService } from './abandoned-checkout-resume'
import { createBundleCheckout } from './bundle-checkout'
import { validateDiscount } from './discounts'
import { unsubscribeByEmail, updateSyncStatus } from './marketing-subscribers'
import { syncUnsubscribeFromResend } from './resend-marketing'

/** The existing marketing unsubscribe: Neon is the source of truth, Resend sync is best effort. */
async function unsubscribeMarketing(email: string): Promise<void> {
  const wasSubscribed = await unsubscribeByEmail(email)
  if (!wasSubscribed) return
  if (process.env.RESEND_MARKETING_CONTACT_SYNC_ENABLED !== 'true') return
  try {
    const rows = await sql`SELECT id, resend_contact_id AS "resendContactId" FROM marketing_subscribers WHERE email = ${email} LIMIT 1`
    const row = (rows as any[])[0]
    if (row) {
      const sync = await syncUnsubscribeFromResend({ contactId: row.resendContactId, email })
      await updateSyncStatus(row.id, sync.ok ? 'synced' : 'failed', null, sync.ok ? null : sync.error, 'unsubscribed')
    }
  } catch { /* the Neon unsubscribe already happened; sync is retried by the existing job */ }
}

export const abandonedService = createAbandonedCheckoutService(sql, { unsubscribeMarketing })
export const resumeService = createResumeService(sql, { validateDiscount, bundles: createBundleCheckout(sql) })
