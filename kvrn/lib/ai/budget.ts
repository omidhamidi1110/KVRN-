import { sql } from '@/lib/db'
import type { AiBudgetSnapshot } from './types'

const DEFAULTS = {
  targetMonthlyMicros: 1_000_000,
  warning1Micros: 2_000_000,
  warning2Micros: 3_000_000,
  essentialOnlyMicros: 3_500_000,
  operationalCutoffMicros: 4_000_000,
  absoluteCeilingMicros: 5_000_000,
}

export async function getAiBudgetSnapshot(now: Date = new Date()): Promise<AiBudgetSnapshot> {
  const nowIso = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString()
  const boundsRows = await sql`
    WITH settings AS (
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name=ai_runtime_settings.business_timezone)
          THEN business_timezone
        ELSE 'America/Los_Angeles'
      END AS timezone
      FROM ai_runtime_settings WHERE id=1
    ), chosen AS (
      SELECT COALESCE((SELECT timezone FROM settings LIMIT 1),'America/Los_Angeles') AS timezone
    )
    SELECT timezone,
      (date_trunc('month', ${nowIso}::timestamptz AT TIME ZONE timezone) AT TIME ZONE timezone) AS month_start,
      ((date_trunc('month', ${nowIso}::timestamptz AT TIME ZONE timezone) + INTERVAL '1 month') AT TIME ZONE timezone) AS month_end
    FROM chosen
  ` as any[]
  const bounds = boundsRows[0] ?? {}
  const monthStart = new Date(bounds.month_start ?? nowIso).toISOString()
  const monthEnd = new Date(bounds.month_end ?? nowIso).toISOString()

  const [controlsRows, spendRows, reservationRows, orphanRows] = await Promise.all([
    sql`
      SELECT target_monthly_micros, warning_1_micros, warning_2_micros,
             essential_only_micros, operational_cutoff_micros, absolute_ceiling_micros,
             manually_locked
      FROM ai_budget_controls WHERE id='global' LIMIT 1
    ` as Promise<any[]>,
    sql`
      SELECT COALESCE(SUM(cost_micros), 0)::bigint AS spend
      FROM ai_model_calls
      WHERE created_at >= ${monthStart}::timestamptz AND created_at < ${monthEnd}::timestamptz
        AND status IN ('succeeded','failed')
    ` as Promise<any[]>,
    sql`
      SELECT COALESCE(SUM(estimated_micros), 0)::bigint AS reserved
      FROM ai_budget_reservations
      WHERE state='reserved' AND expires_at > NOW()
    ` as Promise<any[]>,
    sql`
      SELECT COALESCE(SUM(r.estimated_micros), 0)::bigint AS orphaned
      FROM ai_budget_reservations r
      WHERE (
        (r.state='expired' AND r.released_at >= ${monthStart}::timestamptz AND r.released_at < ${monthEnd}::timestamptz)
        OR (r.state='reserved' AND r.expires_at <= NOW() AND r.expires_at >= ${monthStart}::timestamptz AND r.expires_at < ${monthEnd}::timestamptz)
      )
      AND NOT EXISTS (SELECT 1 FROM ai_model_calls mc WHERE mc.reservation_id=r.id)
    ` as Promise<any[]>,
  ])

  const c = controlsRows[0] ?? {}
  const monthSpendMicros = Number(spendRows[0]?.spend ?? 0)
  const activeReservationMicros = Number(reservationRows[0]?.reserved ?? 0)
  const orphanedReservationMicros = Number(orphanRows[0]?.orphaned ?? 0)
  const effectiveCommittedMicros = monthSpendMicros + activeReservationMicros + orphanedReservationMicros
  const targetMonthlyMicros = Number(c.target_monthly_micros ?? DEFAULTS.targetMonthlyMicros)
  const warning1Micros = Number(c.warning_1_micros ?? DEFAULTS.warning1Micros)
  const warning2Micros = Number(c.warning_2_micros ?? DEFAULTS.warning2Micros)
  const essentialOnlyMicros = Math.min(DEFAULTS.essentialOnlyMicros, Number(c.essential_only_micros ?? DEFAULTS.essentialOnlyMicros))
  const operationalCutoffMicros = Math.min(DEFAULTS.operationalCutoffMicros, Number(c.operational_cutoff_micros ?? DEFAULTS.operationalCutoffMicros))
  const absoluteCeilingMicros = Math.min(DEFAULTS.absoluteCeilingMicros, Number(c.absolute_ceiling_micros ?? DEFAULTS.absoluteCeilingMicros))
  const manuallyLocked = Boolean(c.manually_locked)

  let mode: AiBudgetSnapshot['mode'] = 'normal'
  if (manuallyLocked || effectiveCommittedMicros >= operationalCutoffMicros) mode = 'locked'
  else if (effectiveCommittedMicros >= essentialOnlyMicros) mode = 'essential_only'
  else if (effectiveCommittedMicros >= warning2Micros) mode = 'reduced'

  return {
    monthSpendMicros,
    activeReservationMicros,
    orphanedReservationMicros,
    effectiveCommittedMicros,
    targetMonthlyMicros,
    warning1Micros,
    warning2Micros,
    essentialOnlyMicros,
    operationalCutoffMicros,
    absoluteCeilingMicros,
    manuallyLocked,
    mode,
    remainingToOperationalCutoffMicros: Math.max(0, operationalCutoffMicros - effectiveCommittedMicros),
  }
}

export function canSpendAi(snapshot: AiBudgetSnapshot, estimatedMicros: number, essential: boolean): { ok: boolean; reason?: string } {
  if (snapshot.manuallyLocked || snapshot.mode === 'locked') return { ok: false, reason: 'AI_BUDGET_LOCKED' }
  if (snapshot.mode === 'essential_only' && !essential) return { ok: false, reason: 'AI_ESSENTIAL_ONLY' }
  if (estimatedMicros < 0) return { ok: false, reason: 'AI_BAD_COST_ESTIMATE' }
  if (snapshot.effectiveCommittedMicros + estimatedMicros >= snapshot.operationalCutoffMicros) {
    return { ok: false, reason: 'AI_OPERATIONAL_CUTOFF' }
  }
  if (snapshot.effectiveCommittedMicros + estimatedMicros >= snapshot.absoluteCeilingMicros) {
    return { ok: false, reason: 'AI_ABSOLUTE_CEILING' }
  }
  return { ok: true }
}

export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}
