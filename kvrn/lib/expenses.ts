// lib/expenses.ts — operating cost model and advertising spend
// Server-only.
//
// THREE LAYERS THAT MUST NEVER BE COLLAPSED:
//
//   expense_definitions      EXPECTED   — a recurring obligation. Not a bill.
//   expense_transactions     ACTUAL     — a real invoice. The only thing that
//                                         reduces realised operating profit.
//   provider_usage_snapshots ESTIMATE   — a forecast from usage. Never a bill.
//
// A "$19/month Neon plan" definition does NOT mean $19 was spent. Until an invoice
// is recorded as a transaction, realised profit is untouched by it. Presenting an
// expectation as a billed cost would understate historical profit with money that
// was never actually paid.
//
// None of these are COGS — that is per-unit landed product cost on order_items.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export const EXPENSE_CATEGORIES = [
  'infrastructure', 'development', 'communications', 'payments', 'shipping_platform',
  'domain', 'software', 'contractor', 'packaging', 'other',
] as const
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number]

/**
 * Build tooling is reported apart from production runtime cost so the core business
 * result is legible before development spend is applied.
 */
export const DEVELOPMENT_CATEGORY: ExpenseCategory = 'development'

export const CADENCES = ['monthly', 'annual', 'one_time', 'usage_based'] as const
export type ExpenseCadence = typeof CADENCES[number]

export const TRANSACTION_SOURCES = ['manual', 'provider_api', 'imported'] as const
export type TransactionSource = typeof TRANSACTION_SOURCES[number]

export const USAGE_SOURCES = ['provider_api', 'manual', 'estimated'] as const
export type UsageSource = typeof USAGE_SOURCES[number]

export const AD_PLATFORMS = [
  'meta', 'instagram', 'tiktok', 'google', 'influencer',
  'photographer', 'videographer', 'creative_production', 'other',
] as const
export type AdPlatform = typeof AD_PLATFORMS[number]

export const AD_PROVIDER_SOURCES = ['manual', 'api', 'imported'] as const
export type AdProviderSource = typeof AD_PROVIDER_SOURCES[number]

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/
const MAX_CENTS = 100_000_00

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpenseDefinitionInput {
  provider:             string
  category:             ExpenseCategory
  name:                 string
  cadence:              ExpenseCadence
  expectedAmountCents?: number | null
  renewalDate?:         string | null
  active?:              boolean
  notes?:               string | null
}

export interface ExpenseTransactionInput {
  expenseDefinitionId?: string | null
  provider:             string
  category:             ExpenseCategory
  name:                 string
  amountCents:          number
  periodStart?:         string | null
  periodEnd?:           string | null
  paidAt?:              string | null
  invoiceId?:           string | null
  source?:              TransactionSource
  notes?:               string | null
}

export interface UsageSnapshotInput {
  provider:                 string
  metricName:               string
  metricUnit:               string
  usageValue?:              number | null
  includedAllowance?:       number | null
  estimatedAccruedCents?:   number | null
  projectedMonthEndCents?:  number | null
  thresholdStatus?:         'ok' | 'warning' | 'critical' | null
  billingPeriodStart?:      string | null
  billingPeriodEnd?:        string | null
  source?:                  UsageSource
  notes?:                   string | null
}

export interface AdSpendInput {
  platform:      AdPlatform
  campaignName?: string | null
  campaignId?:   string | null
  spendCents:    number
  periodStart:   string
  periodEnd:     string
  providerReportedRevenueCents?: number | null
  providerReportedOrders?:       number | null
  providerSource?: AdProviderSource | null
  notes?:        string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

type Result = { ok: true } | { ok: false; error: string }

function checkCents(label: string, v: unknown, required = true): string | null {
  if (v === undefined || v === null) {
    return required ? `${label} is required.` : null
  }
  if (!Number.isInteger(v) || (v as number) < 0) {
    return `${label} must be a non-negative whole number of cents.`
  }
  if ((v as number) > MAX_CENTS) return `${label} exceeds the maximum of $100,000.`
  return null
}

export function validateExpenseDefinition(d: Partial<ExpenseDefinitionInput>): Result {
  if (!d.provider || !d.provider.trim()) return { ok: false, error: 'Provider is required.' }
  if (d.provider.length > 80)            return { ok: false, error: 'Provider must be 80 characters or fewer.' }
  if (!d.name || !d.name.trim())         return { ok: false, error: 'Name is required.' }
  if (d.name.length > 120)               return { ok: false, error: 'Name must be 120 characters or fewer.' }
  if (!d.category || !EXPENSE_CATEGORIES.includes(d.category)) {
    return { ok: false, error: 'A valid category is required.' }
  }
  if (!d.cadence || !CADENCES.includes(d.cadence)) {
    return { ok: false, error: 'A valid cadence is required.' }
  }
  // usage_based obligations have no fixed expected amount; every other cadence must.
  if (d.cadence !== 'usage_based') {
    const err = checkCents('Expected amount', d.expectedAmountCents)
    if (err) return { ok: false, error: err }
  } else if (d.expectedAmountCents !== undefined && d.expectedAmountCents !== null) {
    const err = checkCents('Expected amount', d.expectedAmountCents, false)
    if (err) return { ok: false, error: err }
  }
  if (d.renewalDate && !DATE_RE.test(d.renewalDate)) {
    return { ok: false, error: 'Renewal date must be YYYY-MM-DD.' }
  }
  return { ok: true }
}

export function validateExpenseTransaction(d: Partial<ExpenseTransactionInput>): Result {
  if (!d.provider || !d.provider.trim()) return { ok: false, error: 'Provider is required.' }
  if (!d.name || !d.name.trim())         return { ok: false, error: 'Name is required.' }
  if (!d.category || !EXPENSE_CATEGORIES.includes(d.category)) {
    return { ok: false, error: 'A valid category is required.' }
  }
  const err = checkCents('Amount', d.amountCents)
  if (err) return { ok: false, error: err }

  for (const [label, v] of [
    ['Period start', d.periodStart], ['Period end', d.periodEnd], ['Paid date', d.paidAt],
  ] as Array<[string, unknown]>) {
    if (v && !DATE_RE.test(v as string)) {
      return { ok: false, error: `${label} must be YYYY-MM-DD.` }
    }
  }
  if (d.periodStart && d.periodEnd && d.periodEnd < d.periodStart) {
    return { ok: false, error: 'Period end cannot be before period start.' }
  }
  if (d.source && !TRANSACTION_SOURCES.includes(d.source)) {
    return { ok: false, error: 'Source must be manual, provider_api or imported.' }
  }
  return { ok: true }
}

export function validateUsageSnapshot(d: Partial<UsageSnapshotInput>): Result {
  if (!d.provider || !d.provider.trim())     return { ok: false, error: 'Provider is required.' }
  if (!d.metricName || !d.metricName.trim()) return { ok: false, error: 'Metric name is required.' }
  // Without a unit the reading is meaningless: 42 CU-hours is not 42 GB.
  if (!d.metricUnit || !d.metricUnit.trim()) return { ok: false, error: 'Metric unit is required.' }

  for (const [label, v] of [
    ['Estimated accrued', d.estimatedAccruedCents],
    ['Projected month end', d.projectedMonthEndCents],
  ] as Array<[string, unknown]>) {
    const err = checkCents(label, v, false)
    if (err) return { ok: false, error: err }
  }
  if (d.thresholdStatus && !['ok','warning','critical'].includes(d.thresholdStatus)) {
    return { ok: false, error: 'Threshold status must be ok, warning or critical.' }
  }
  if (d.source && !USAGE_SOURCES.includes(d.source)) {
    return { ok: false, error: 'Source must be provider_api, manual or estimated.' }
  }
  return { ok: true }
}

export function validateAdSpendInput(d: Partial<AdSpendInput>): Result {
  if (!d.platform || !AD_PLATFORMS.includes(d.platform)) {
    return { ok: false, error: 'A valid platform is required.' }
  }
  const err = checkCents('Spend', d.spendCents)
  if (err) return { ok: false, error: err }

  if (!d.periodStart || !DATE_RE.test(d.periodStart)) {
    return { ok: false, error: 'Period start must be YYYY-MM-DD.' }
  }
  if (!d.periodEnd || !DATE_RE.test(d.periodEnd)) {
    return { ok: false, error: 'Period end must be YYYY-MM-DD.' }
  }
  if (d.periodEnd < d.periodStart) {
    return { ok: false, error: 'Period end cannot be before period start.' }
  }
  if (d.providerSource && !AD_PROVIDER_SOURCES.includes(d.providerSource)) {
    return { ok: false, error: 'Provider source must be manual, api or imported.' }
  }
  for (const [label, v] of [
    ['Reported revenue', d.providerReportedRevenueCents],
    ['Reported orders',  d.providerReportedOrders],
  ] as Array<[string, unknown]>) {
    if (v === undefined || v === null) continue
    if (!Number.isInteger(v) || (v as number) < 0) {
      return { ok: false, error: `${label} must be a non-negative whole number.` }
    }
  }
  return { ok: true }
}

/**
 * Monthly equivalent of a recurring obligation, for planning display only.
 *
 * A $40 annual renewal shows as $3.33/month in the infrastructure dashboard, but
 * this is pure arithmetic for comparison — it never produces twelve billed rows and
 * never touches realised profit. The single $40 transaction remains the only fact.
 */
export function monthlyEquivalentCents(
  cadence: ExpenseCadence,
  expectedAmountCents: number | null,
): number | null {
  if (expectedAmountCents === null || expectedAmountCents === undefined) return null
  switch (cadence) {
    case 'monthly': return expectedAmountCents
    case 'annual':  return Math.round(expectedAmountCents / 12)
    default:        return null   // one_time and usage_based have no monthly rate
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export function createExpenseService(sql: NeonQueryFunction<false, false>) {
  return {
    // ── Definitions (EXPECTED) ───────────────────────────────────────────────
    async listDefinitions() {
      const rows = await sql`
        SELECT id, provider, category, name, cadence,
               expected_amount_cents AS "expectedAmountCents",
               renewal_date AS "renewalDate", active, notes,
               created_by AS "createdBy", created_at AS "createdAt"
        FROM expense_definitions
        ORDER BY provider, name
      `
      return (rows as any[]).map(r => ({
        ...r,
        expectedAmountCents: r.expectedAmountCents === null ? null : Number(r.expectedAmountCents),
        renewalDate: r.renewalDate ? String(r.renewalDate).slice(0, 10) : null,
        monthlyEquivalentCents: monthlyEquivalentCents(
          r.cadence,
          r.expectedAmountCents === null ? null : Number(r.expectedAmountCents),
        ),
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    },

    async createDefinition(d: ExpenseDefinitionInput, actorEmail: string) {
      const rows = await sql`
        INSERT INTO expense_definitions (
          provider, category, name, cadence, expected_amount_cents,
          renewal_date, active, notes, created_by
        ) VALUES (
          ${d.provider.trim()}, ${d.category}::kvrn_expense_category, ${d.name.trim()},
          ${d.cadence}, ${d.expectedAmountCents ?? null},
          ${d.renewalDate ?? null}::date, ${d.active !== false},
          ${d.notes ?? null}, ${actorEmail}
        )
        RETURNING id, created_at AS "createdAt"
      `
      return (rows as any[])[0]
    },

    async deleteDefinition(id: string) {
      const rows = await sql`DELETE FROM expense_definitions WHERE id = ${id}::uuid RETURNING id`
      return (rows as any[]).length > 0
    },

    // ── Transactions (ACTUAL) ────────────────────────────────────────────────
    async listTransactions() {
      const rows = await sql`
        SELECT t.id, t.expense_definition_id AS "expenseDefinitionId",
               t.provider, t.category, t.name,
               t.amount_cents AS "amountCents",
               t.period_start AS "periodStart", t.period_end AS "periodEnd",
               t.paid_at AS "paidAt", t.invoice_id AS "invoiceId", t.source, t.notes,
               t.created_by AS "createdBy", t.created_at AS "createdAt",
               d.name AS "definitionName"
        FROM expense_transactions t
        LEFT JOIN expense_definitions d ON d.id = t.expense_definition_id
        ORDER BY COALESCE(t.paid_at, t.period_start, t.created_at::date) DESC,
                 t.created_at DESC
      `
      return (rows as any[]).map(r => ({
        ...r,
        amountCents: Number(r.amountCents),
        periodStart: r.periodStart ? String(r.periodStart).slice(0, 10) : null,
        periodEnd:   r.periodEnd   ? String(r.periodEnd).slice(0, 10)   : null,
        paidAt:      r.paidAt      ? String(r.paidAt).slice(0, 10)      : null,
        createdAt:   new Date(r.createdAt).toISOString(),
      }))
    },

    async createTransaction(d: ExpenseTransactionInput, actorEmail: string) {
      const rows = await sql`
        INSERT INTO expense_transactions (
          expense_definition_id, provider, category, name, amount_cents,
          period_start, period_end, paid_at, invoice_id, source, notes, created_by
        ) VALUES (
          ${d.expenseDefinitionId ?? null}::uuid, ${d.provider.trim()},
          ${d.category}::kvrn_expense_category, ${d.name.trim()}, ${d.amountCents},
          ${d.periodStart ?? null}::date, ${d.periodEnd ?? null}::date,
          ${d.paidAt ?? null}::date, ${d.invoiceId ?? null},
          ${d.source ?? 'manual'}, ${d.notes ?? null}, ${actorEmail}
        )
        RETURNING id, created_at AS "createdAt"
      `
      return (rows as any[])[0]
    },

    async deleteTransaction(id: string) {
      const rows = await sql`DELETE FROM expense_transactions WHERE id = ${id}::uuid RETURNING id`
      return (rows as any[]).length > 0
    },

    // ── Usage snapshots (ESTIMATE / PROJECTION) ──────────────────────────────
    async listLatestUsageSnapshots() {
      // One row per provider+metric: the most recent reading.
      const rows = await sql`
        SELECT DISTINCT ON (provider, metric_name)
               id, provider, metric_name AS "metricName", metric_unit AS "metricUnit",
               usage_value AS "usageValue", included_allowance AS "includedAllowance",
               estimated_accrued_cents   AS "estimatedAccruedCents",
               projected_month_end_cents AS "projectedMonthEndCents",
               threshold_status AS "thresholdStatus",
               billing_period_start AS "billingPeriodStart",
               billing_period_end   AS "billingPeriodEnd",
               source, notes, captured_at AS "capturedAt"
        FROM provider_usage_snapshots
        ORDER BY provider, metric_name, captured_at DESC
      `
      return (rows as any[]).map(r => ({
        ...r,
        usageValue:             r.usageValue        === null ? null : Number(r.usageValue),
        includedAllowance:      r.includedAllowance === null ? null : Number(r.includedAllowance),
        estimatedAccruedCents:  r.estimatedAccruedCents  === null ? null : Number(r.estimatedAccruedCents),
        projectedMonthEndCents: r.projectedMonthEndCents === null ? null : Number(r.projectedMonthEndCents),
        billingPeriodStart: r.billingPeriodStart ? String(r.billingPeriodStart).slice(0, 10) : null,
        billingPeriodEnd:   r.billingPeriodEnd   ? String(r.billingPeriodEnd).slice(0, 10)   : null,
        capturedAt: new Date(r.capturedAt).toISOString(),
      }))
    },

    async createUsageSnapshot(d: UsageSnapshotInput, actorEmail: string) {
      const rows = await sql`
        INSERT INTO provider_usage_snapshots (
          provider, metric_name, metric_unit, usage_value, included_allowance,
          estimated_accrued_cents, projected_month_end_cents, threshold_status,
          billing_period_start, billing_period_end, source, notes, created_by
        ) VALUES (
          ${d.provider.trim()}, ${d.metricName.trim()}, ${d.metricUnit.trim()},
          ${d.usageValue ?? null}, ${d.includedAllowance ?? null},
          ${d.estimatedAccruedCents ?? null}, ${d.projectedMonthEndCents ?? null},
          ${d.thresholdStatus ?? null},
          ${d.billingPeriodStart ?? null}::date, ${d.billingPeriodEnd ?? null}::date,
          ${d.source ?? 'manual'}, ${d.notes ?? null}, ${actorEmail}
        )
        RETURNING id, captured_at AS "capturedAt"
      `
      return (rows as any[])[0]
    },

    // ── Ad spend ─────────────────────────────────────────────────────────────
    async listAdSpend() {
      const rows = await sql`
        SELECT id, platform, campaign_name AS "campaignName", campaign_id AS "campaignId",
               spend_cents AS "spendCents",
               period_start AS "periodStart", period_end AS "periodEnd",
               provider_reported_revenue_cents AS "providerReportedRevenueCents",
               provider_reported_orders        AS "providerReportedOrders",
               provider_source AS "providerSource",
               notes, created_by AS "createdBy", created_at AS "createdAt"
        FROM ad_spend
        ORDER BY period_start DESC, created_at DESC
      `
      return (rows as any[]).map(r => ({
        ...r,
        spendCents:  Number(r.spendCents),
        periodStart: String(r.periodStart).slice(0, 10),
        periodEnd:   String(r.periodEnd).slice(0, 10),
        providerReportedRevenueCents:
          r.providerReportedRevenueCents === null ? null : Number(r.providerReportedRevenueCents),
        providerReportedOrders:
          r.providerReportedOrders === null ? null : Number(r.providerReportedOrders),
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    },

    async createAdSpend(d: AdSpendInput, actorEmail: string) {
      const rows = await sql`
        INSERT INTO ad_spend (
          platform, campaign_name, campaign_id, spend_cents,
          period_start, period_end,
          provider_reported_revenue_cents, provider_reported_orders, provider_source,
          notes, created_by
        ) VALUES (
          ${d.platform}, ${d.campaignName ?? null}, ${d.campaignId ?? null}, ${d.spendCents},
          ${d.periodStart}::date, ${d.periodEnd}::date,
          ${d.providerReportedRevenueCents ?? null}, ${d.providerReportedOrders ?? null},
          ${d.providerSource ?? null},
          ${d.notes ?? null}, ${actorEmail}
        )
        RETURNING id, created_at AS "createdAt"
      `
      return (rows as any[])[0]
    },

    async deleteAdSpend(id: string) {
      const rows = await sql`DELETE FROM ad_spend WHERE id = ${id}::uuid RETURNING id`
      return (rows as any[]).length > 0
    },

    async getAdSpendByPlatform(startDate: string, endDate: string) {
      const rows = await sql`
        SELECT platform,
               SUM(spend_cents)::int AS "spendCents",
               COUNT(*)::int         AS "entries"
        FROM ad_spend
        WHERE period_start <= ${endDate}::date AND period_end >= ${startDate}::date
        GROUP BY platform
        ORDER BY SUM(spend_cents) DESC
      `
      return (rows as any[]).map(r => ({
        platform:   r.platform as AdPlatform,
        spendCents: Number(r.spendCents),
        entries:    Number(r.entries),
      }))
    },

    /**
     * Provider-by-provider infrastructure cost view.
     *
     * Returns the three states side by side and NEVER merges them:
     *   actualPaidCents        from expense_transactions (fact: money that left)
     *   estimatedAccruedCents  from usage snapshots      (forecast)
     *   projectedMonthEndCents from usage snapshots      (forecast)
     *
     * A provider may legitimately have SEVERAL obligations (Twilio: a phone number
     * and a messaging plan) and SEVERAL billable metrics (Neon: compute and
     * storage). Both are returned as arrays; nothing is silently dropped.
     *
     * FORECAST AGGREGATION MATCHES THE FINANCIAL OVERVIEW EXACTLY: the latest
     * snapshot per (provider, metric_name) is taken and summed. Keying on provider
     * alone would drop metrics here and make the two surfaces disagree.
     */
    async getInfrastructureCosts(startDate: string, endDate: string) {
      const [defs, txns, usage] = await Promise.all([
        sql`
          SELECT id, provider, category, name, cadence,
                 expected_amount_cents AS "expectedAmountCents",
                 renewal_date AS "renewalDate", active
          FROM expense_definitions WHERE active = TRUE
          ORDER BY provider, name
        `,
        sql`
          SELECT provider, category,
                 SUM(amount_cents)::int AS "actualPaidCents",
                 COUNT(*)::int          AS "transactionCount"
          FROM expense_transactions
          WHERE paid_at IS NOT NULL
            AND paid_at >= ${startDate}::date AND paid_at <= ${endDate}::date
          GROUP BY provider, category
        `,
        // Latest reading per provider+metric — identical key to the Overview query.
        sql`
          SELECT DISTINCT ON (provider, metric_name)
                 provider, metric_name AS "metricName", metric_unit AS "metricUnit",
                 usage_value AS "usageValue", included_allowance AS "includedAllowance",
                 estimated_accrued_cents   AS "estimatedAccruedCents",
                 projected_month_end_cents AS "projectedMonthEndCents",
                 threshold_status AS "thresholdStatus", source,
                 billing_period_start AS "billingPeriodStart",
                 billing_period_end   AS "billingPeriodEnd",
                 captured_at AS "capturedAt"
          FROM provider_usage_snapshots
          ORDER BY provider, metric_name, captured_at DESC
        `,
      ])

      const providers = new Set<string>()
      for (const r of defs  as any[]) providers.add(r.provider)
      for (const r of txns  as any[]) providers.add(r.provider)
      for (const r of usage as any[]) providers.add(r.provider)

      const num = (v: any) => (v === null || v === undefined ? null : Number(v))

      return [...providers].sort().map(provider => {
        // ALL obligations for this provider, not just the first.
        const providerDefs = (defs as any[])
          .filter(d => d.provider === provider)
          .map(d => {
            const expected = num(d.expectedAmountCents)
            return {
              id:          d.id,
              name:        d.name,
              category:    d.category,
              cadence:     d.cadence,
              expectedAmountCents:    expected,
              monthlyEquivalentCents: monthlyEquivalentCents(d.cadence, expected),
              renewalDate: d.renewalDate ? String(d.renewalDate).slice(0, 10) : null,
            }
          })

        // ALL billable metrics for this provider, not just the first.
        const providerUsage = (usage as any[])
          .filter(u => u.provider === provider)
          .map(u => ({
            metricName:             u.metricName,
            metricUnit:             u.metricUnit,
            usageValue:             num(u.usageValue),
            includedAllowance:      num(u.includedAllowance),
            estimatedAccruedCents:  num(u.estimatedAccruedCents),
            projectedMonthEndCents: num(u.projectedMonthEndCents),
            thresholdStatus:        u.thresholdStatus ?? null,
            source:                 u.source ?? null,
            billingPeriodStart: u.billingPeriodStart ? String(u.billingPeriodStart).slice(0, 10) : null,
            billingPeriodEnd:   u.billingPeriodEnd   ? String(u.billingPeriodEnd).slice(0, 10)   : null,
            capturedAt: u.capturedAt ? new Date(u.capturedAt).toISOString() : null,
          }))

        const providerTxns = (txns as any[]).filter(t => t.provider === provider)

        // Sum forecasts across every metric — same rule the Overview applies.
        const sumMetric = (fn: (m: any) => number | null) => {
          const known = providerUsage.map(fn).filter((v): v is number => v !== null)
          return known.length === 0 ? null : known.reduce((s, v) => s + v, 0)
        }

        // Monthly planning equivalent across all obligations, where meaningful.
        const monthlyEquivalents = providerDefs
          .map(d => d.monthlyEquivalentCents)
          .filter((v): v is number => v !== null)

        // Worst status across metrics drives the provider row.
        const RANK: Record<string, number> = { ok: 0, warning: 1, critical: 2 }
        const worstStatus = providerUsage.reduce<string | null>((worst, m) => {
          if (!m.thresholdStatus) return worst
          if (!worst) return m.thresholdStatus
          return RANK[m.thresholdStatus] > RANK[worst] ? m.thresholdStatus : worst
        }, null)

        return {
          provider,
          category: providerDefs[0]?.category ?? providerTxns[0]?.category ?? 'other',

          // EXPECTED — every obligation, plus a planning aggregate
          definitions: providerDefs,
          expectedMonthlyEquivalentCents:
            monthlyEquivalents.length === 0
              ? null
              : monthlyEquivalents.reduce((s, v) => s + v, 0),

          // ACTUAL PAID — real invoices settled inside the window
          actualPaidCents: providerTxns.length > 0
            ? providerTxns.reduce((s: number, t: any) => s + Number(t.actualPaidCents), 0)
            : null,
          transactionCount: providerTxns.reduce(
            (s: number, t: any) => s + Number(t.transactionCount), 0),

          // FORECASTS — every metric, plus provider aggregates
          usageMetrics: providerUsage,
          estimatedAccruedCents:  sumMetric(m => m.estimatedAccruedCents),
          projectedMonthEndCents: sumMetric(m => m.projectedMonthEndCents),
          thresholdStatus: worstStatus,
        }
      })
    },
  }
}

export type ExpenseService = ReturnType<typeof createExpenseService>
