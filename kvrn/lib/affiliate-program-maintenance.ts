// lib/affiliate-program-maintenance.ts — scheduled housekeeping for the affiliate program.
// Idempotent. Terminates affiliates whose program end date has passed (history untouched), expires
// stale invites, and drains the email outbox. Returns safe counts only.

import type { EmailProvider } from './resend-adapter'
import { drainAffiliateEmailOutbox } from './affiliate-program-email'

type Sql = any

export interface MaintenanceResult {
  terminated: number
  email: { processed: number; sent: number; failed: number }
}

export async function runAffiliateProgramMaintenance(sql: Sql, getProvider: () => EmailProvider): Promise<MaintenanceResult> {
  const rows = await sql`SELECT apply_due_affiliate_program_dates() AS r` as any[]
  const terminated = Number(rows[0]?.r?.terminated ?? 0)
  let email = { processed: 0, sent: 0, failed: 0 }
  try {
    email = await drainAffiliateEmailOutbox(sql, getProvider())
  } catch {
    // no provider configured: rows stay queued
  }
  return { terminated, email }
}
