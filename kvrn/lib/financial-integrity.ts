// lib/financial-integrity.ts
//
// Data access + presentation helpers for the financial integrity layer (migration
// 021). The reconciliation LOGIC lives in SQL (financial_integrity_scan() and the
// fi_scan_* functions) because every invariant is a statement about rows; this file
// only reads the derived result, records detection history, and formats it.
//
// ── THREE STATES, NEVER A BOOLEAN ────────────────────────────────────────────
//   RECONCILED  every required fact is known and consistent
//   INCOMPLETE  a required fact is unknown / unresolved (unknown is NOT zero)
//   EXCEPTION   data exists but contradicts an invariant or another source
// Advisories are disclosed assumptions that never change an entity's state.
//
// There is no stored "reconciled" flag. Calling the scan again always re-derives
// the answer from the authoritative rows, so a fix in the data clears the finding
// by itself and a regression brings it back.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export type IntegrityState = 'exception' | 'incomplete' | 'advisory'
export type EntityState = 'RECONCILED' | 'INCOMPLETE' | 'EXCEPTION'
export type ResolutionKind = 'automatic' | 'manual_data' | 'manual_review'

export interface IntegrityFinding {
  fingerprint: string
  issueCode: string
  state: IntegrityState
  domain: string
  entityType: string
  entityId: string
  entityLabel: string | null
  orderId: string | null
  summary: string
  evidence: Record<string, unknown>
  resolution: ResolutionKind
  actionPath: string | null
  /** When the recorder first saw this issue (current episode). null = never recorded. */
  detectedAt: string | null
}

export interface IntegritySummary {
  /** Live: the scan was executed for this request. */
  scannedAt: string
  /** Last time someone recorded a run into the append-only history. null = never. */
  lastRecordedRunAt: string | null
  entities: { total: number; reconciled: number; incomplete: number; exception: number }
  findings: { exception: number; incomplete: number; advisory: number }
  /** Overall verdict: any exception -> EXCEPTION, else any incomplete -> INCOMPLETE. */
  overall: EntityState
  byType: Array<{
    entityType: string; total: number; reconciled: number; incomplete: number; exception: number
  }>
  byIssue: Array<{
    issueCode: string; state: IntegrityState; domain: string; resolution: ResolutionKind; count: number
  }>
}

/** Reconciliation state RELEVANT to one reporting period (see financial_integrity_period_state). */
export interface PeriodIntegrity {
  /** RECONCILED = exact profit may be shown as exact; INCOMPLETE = unknown; EXCEPTION = invalid. */
  state: EntityState
  exceptionCount: number
  incompleteCount: number
  /** Orders paid in the window (the cohort whose effects the profit is built from). */
  orderCohortCount: number
  byCode: Array<{ issueCode: string; state: IntegrityState; domain: string; count: number }>
  /** order id -> state, for orders that are NOT reconciled (absent = RECONCILED). */
  orderStates: Record<string, EntityState>
  scope: string
  checkedAt: string
}

export const PERIOD_INTEGRITY_SCOPE =
  'Orders paid in the period (with their refunds, returns, exchanges, disputes, commission, COGS, shipping and fees) ' +
  'plus the expenses, ad spend and inventory write-offs included in the period. Findings outside the period are not counted.'

export function mapPeriodIntegrity(row: any, checkedAt: string): PeriodIntegrity {
  const r = row ?? {}
  return {
    state: (r.state as EntityState) ?? 'RECONCILED',
    exceptionCount: Number(r.exception_count ?? 0),
    incompleteCount: Number(r.incomplete_count ?? 0),
    orderCohortCount: Number(r.order_cohort_count ?? 0),
    byCode: ((r.by_code ?? []) as any[]).map(c => ({
      issueCode: c.issue_code, state: c.state as IntegrityState, domain: c.domain, count: Number(c.count),
    })),
    orderStates: (r.orders ?? {}) as Record<string, EntityState>,
    scope: PERIOD_INTEGRITY_SCOPE,
    checkedAt,
  }
}

/** Derived reconciliation state of ONE order (REV2). Same scan, same rule as the period per-order state. */
export interface OrderIntegrity {
  state: EntityState
  exceptionCount: number
  incompleteCount: number
  byCode: Array<{ issueCode: string; state: IntegrityState; domain: string; summary: string }>
  checkedAt: string
}

/**
 * Fold an order's open scan findings into its state. EXCEPTION if any exception, else
 * INCOMPLETE if any incomplete, else RECONCILED. Advisories never change the state. This is the
 * exact rule financial_integrity_period_state() applies per order, so the two can never disagree.
 */
export function mapOrderIntegrity(rows: any[], checkedAt: string): OrderIntegrity {
  const open = (rows ?? []).filter(r => r.state === 'exception' || r.state === 'incomplete')
  const exceptions = open.filter(r => r.state === 'exception').length
  return {
    state: exceptions > 0 ? 'EXCEPTION' : open.length > 0 ? 'INCOMPLETE' : 'RECONCILED',
    exceptionCount: exceptions,
    incompleteCount: open.length - exceptions,
    byCode: open.map(r => ({ issueCode: r.issue_code, state: r.state as IntegrityState, domain: r.domain, summary: r.summary })),
    checkedAt,
  }
}

export interface FindingFilter {
  state?: IntegrityState
  domain?: string
  issueCode?: string
  entityType?: string
  limit?: number
  offset?: number
}

const STATES: IntegrityState[] = ['exception', 'incomplete', 'advisory']

export function parseFindingFilter(params: URLSearchParams): FindingFilter {
  const f: FindingFilter = {}
  const state = params.get('state')
  if (state && (STATES as string[]).includes(state)) f.state = state as IntegrityState
  const domain = params.get('domain')
  if (domain && /^[a-z_]{1,32}$/.test(domain)) f.domain = domain
  const code = params.get('code')
  if (code && /^[A-Z0-9_]{1,80}$/.test(code)) f.issueCode = code
  const et = params.get('entityType')
  if (et && /^[a-z_]{1,40}$/.test(et)) f.entityType = et
  const limit = Number(params.get('limit'))
  if (Number.isInteger(limit) && limit > 0) f.limit = Math.min(limit, 5000)
  const offset = Number(params.get('offset'))
  if (Number.isInteger(offset) && offset > 0) f.offset = offset
  return f
}

function mapFinding(r: any): IntegrityFinding {
  return {
    fingerprint: r.fingerprint,
    issueCode: r.issue_code,
    state: r.state,
    domain: r.domain,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label ?? null,
    orderId: r.order_id ?? null,
    summary: r.summary,
    evidence: (r.evidence ?? {}) as Record<string, unknown>,
    resolution: r.resolution,
    actionPath: r.action_path ?? null,
    detectedAt: r.detected_at ? new Date(r.detected_at).toISOString() : null,
  }
}

export function createFinancialIntegrityService(sql: NeonQueryFunction<false, false>) {
  return {
    /** Derived integrity state of one order, from the canonical scan (no second calculation). */
    async getOrderIntegrity(orderId: string): Promise<OrderIntegrity> {
      const rows = await sql.query(
        `SELECT issue_code, state, domain, summary
           FROM financial_integrity_scan()
          WHERE order_id = $1::uuid AND state IN ('exception','incomplete')
          ORDER BY CASE state WHEN 'exception' THEN 0 ELSE 1 END, issue_code`,
        [orderId])
      return mapOrderIntegrity(rows as any[], new Date().toISOString())
    },

    /** Every current finding, most severe first, with first-detected time when recorded. */
    async listFindings(filter: FindingFilter = {}): Promise<IntegrityFinding[]> {
      const rows = await sql.query(
        `SELECT * FROM financial_integrity_findings() f
         WHERE ($1::text IS NULL OR f.state = $1)
           AND ($2::text IS NULL OR f.domain = $2)
           AND ($3::text IS NULL OR f.issue_code = $3)
           AND ($4::text IS NULL OR f.entity_type = $4)
         LIMIT $5 OFFSET $6`,
        [filter.state ?? null, filter.domain ?? null, filter.issueCode ?? null,
         filter.entityType ?? null, filter.limit ?? 1000, filter.offset ?? 0],
      )
      return (rows as any[]).map(mapFinding)
    },

    async getSummary(): Promise<IntegritySummary> {
      const [states, issues, lastRun] = await Promise.all([
        sql.query(
          `SELECT entity_type, state, COUNT(*)::int AS n
           FROM financial_integrity_entity_states() GROUP BY entity_type, state`),
        sql.query(
          `SELECT issue_code, state, domain, resolution, COUNT(*)::int AS n
           FROM financial_integrity_scan() GROUP BY issue_code, state, domain, resolution
           ORDER BY CASE state WHEN 'exception' THEN 0 WHEN 'incomplete' THEN 1 ELSE 2 END, issue_code`),
        sql.query(`SELECT MAX(ran_at) AS last_run FROM financial_integrity_runs`),
      ])

      const byTypeMap = new Map<string, IntegritySummary['byType'][number]>()
      const totals = { total: 0, reconciled: 0, incomplete: 0, exception: 0 }
      for (const r of states as any[]) {
        const t = byTypeMap.get(r.entity_type) ??
          { entityType: r.entity_type, total: 0, reconciled: 0, incomplete: 0, exception: 0 }
        const n = Number(r.n)
        t.total += n; totals.total += n
        if (r.state === 'RECONCILED') { t.reconciled += n; totals.reconciled += n }
        if (r.state === 'INCOMPLETE') { t.incomplete += n; totals.incomplete += n }
        if (r.state === 'EXCEPTION')  { t.exception  += n; totals.exception  += n }
        byTypeMap.set(r.entity_type, t)
      }

      const findings = { exception: 0, incomplete: 0, advisory: 0 }
      const byIssue = (issues as any[]).map(r => {
        findings[r.state as IntegrityState] += Number(r.n)
        return {
          issueCode: r.issue_code, state: r.state as IntegrityState, domain: r.domain,
          resolution: r.resolution as ResolutionKind, count: Number(r.n),
        }
      })

      const lr = (lastRun as any[])[0]?.last_run
      return {
        scannedAt: new Date().toISOString(),
        lastRecordedRunAt: lr ? new Date(lr).toISOString() : null,
        entities: totals,
        findings,
        overall: totals.exception > 0 ? 'EXCEPTION'
               : totals.incomplete > 0 ? 'INCOMPLETE' : 'RECONCILED',
        byType: [...byTypeMap.values()].sort((a, b) => a.entityType.localeCompare(b.entityType)),
        byIssue,
      }
    },

    /** Run the scan and append what changed to the history. Append-only. */
    async recordRun(actor: string, trigger: 'manual' | 'api' | 'scheduled' = 'manual') {
      const rows = await sql.query(
        `SELECT record_financial_integrity_run($1, $2) AS r`, [actor, trigger])
      return (rows as any[])[0]?.r as {
        run_id: string; exception_count: number; incomplete_count: number; advisory_count: number
        new_count: number; changed_count: number; resolved_count: number
      }
    },

    /** Recent detection history (newest first). */
    async getHistory(limit = 50) {
      const lim = Math.min(Math.max(1, Math.trunc(limit)), 500)
      const runs = await sql.query(
        `SELECT id, ran_at, actor, trigger, exception_count, incomplete_count, advisory_count,
                new_count, changed_count, resolved_count
         FROM financial_integrity_runs ORDER BY ran_at DESC, id DESC LIMIT $1`, [lim])
      const events = await sql.query(
        `SELECT fingerprint, event_type, issue_code, state, entity_type, entity_id, observed_at, run_id
         FROM financial_integrity_events ORDER BY observed_at DESC, id DESC LIMIT $1`, [lim * 4])
      return { runs: runs as any[], events: events as any[] }
    },
  }
}

export type FinancialIntegrityService = ReturnType<typeof createFinancialIntegrityService>

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'fingerprint', 'issue_code', 'state', 'domain', 'entity_type', 'entity_id',
  'entity_label', 'order_id', 'summary', 'resolution', 'action_path',
  'detected_at', 'last_check_at', 'amounts_cents_json', 'evidence_json',
] as const

/**
 * One CSV cell. RFC 4180 quoting, plus spreadsheet-formula neutralisation: a cell
 * that starts with = + - @ (or a tab / CR) is prefixed so Excel and Sheets treat
 * it as text. Entity labels and evidence come from data other people typed (order
 * numbers, supplier names), so the export must not be an injection vector.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'string' ? value : JSON.stringify(value)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** Only the *_cents members of the evidence: the machine-readable amounts. */
export function amountsOf(evidence: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const walk = (o: unknown, prefix: string) => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (k.endsWith('_cents') && (typeof v === 'number' || v === null)) out[key] = v as number | null
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`))
      else if (v && typeof v === 'object') walk(v, key)
    }
  }
  walk(evidence, '')
  return out
}

export function findingsToCsv(findings: IntegrityFinding[], lastCheckAt: string): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const f of findings) {
    lines.push([
      f.fingerprint, f.issueCode, f.state, f.domain, f.entityType, f.entityId,
      f.entityLabel, f.orderId, f.summary, f.resolution, f.actionPath,
      f.detectedAt, lastCheckAt, amountsOf(f.evidence), f.evidence,
    ].map(csvCell).join(','))
  }
  // CRLF per RFC 4180; trailing newline so appended exports concatenate cleanly.
  return lines.join('\r\n') + '\r\n'
}
