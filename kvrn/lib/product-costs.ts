// lib/product-costs.ts — product cost batch (COGS) management
// Server-only.
//
// LANDED UNIT COGS =
//   manufacturing + inbound freight + duties + tariffs + import tax
//   + packaging + other landed costs
//
// Cost batches describe what inventory COSTS KVRN. They are the CURRENT catalogue.
// They are NOT what historical orders used: finalize_paid_order snapshots the
// resolved cost onto order_items at the moment of sale, so editing or adding a
// batch here can never retroactively change a past order's profitability.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export interface CostBatchInput {
  productId:           string
  variantId?:          string | null
  colorName?:          string | null
  batchLabel?:         string | null
  manufacturingCents:  number
  freightCents:        number
  dutiesCents:         number
  tariffsCents:        number
  importTaxCents:      number
  packagingCents:      number
  otherLandedCents:    number
  effectiveFrom:       string   // yyyy-mm-dd
  note?:               string | null
}

export interface CostBatchRow extends CostBatchInput {
  id:             string
  unitCogsCents:  number
  productName:    string | null
  variantSku:     string | null
  createdBy:      string | null
  createdAt:      string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Validate admin input server-side. Never trust the client. */
export function validateCostBatchInput(
  data: Partial<CostBatchInput>
): { ok: true } | { ok: false; error: string } {
  if (!data.productId || !UUID_RE.test(data.productId)) {
    return { ok: false, error: 'A valid product is required.' }
  }
  if (data.variantId && !UUID_RE.test(data.variantId)) {
    return { ok: false, error: 'Variant id is not valid.' }
  }
  // The DB enforces this too; checked here for a friendlier message.
  if (data.variantId && data.colorName) {
    return { ok: false, error: 'A batch may target a variant OR a colour, not both.' }
  }
  if (!data.effectiveFrom || !DATE_RE.test(data.effectiveFrom)) {
    return { ok: false, error: 'Effective date must be YYYY-MM-DD.' }
  }

  const components: Array<[string, unknown]> = [
    ['Manufacturing', data.manufacturingCents],
    ['Freight',       data.freightCents],
    ['Duties',        data.dutiesCents],
    ['Tariffs',       data.tariffsCents],
    ['Import tax',    data.importTaxCents],
    ['Packaging',     data.packagingCents],
    ['Other landed',  data.otherLandedCents],
  ]
  for (const [label, value] of components) {
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || (value as number) < 0) {
      return { ok: false, error: `${label} must be a non-negative whole number of cents.` }
    }
    if ((value as number) > 10_000_00) {
      return { ok: false, error: `${label} exceeds the maximum of $10,000.` }
    }
  }

  const total =
    (data.manufacturingCents ?? 0) + (data.freightCents ?? 0) + (data.dutiesCents ?? 0) +
    (data.tariffsCents ?? 0) + (data.importTaxCents ?? 0) +
    (data.packagingCents ?? 0) + (data.otherLandedCents ?? 0)
  if (total <= 0) {
    return { ok: false, error: 'At least one cost component must be greater than zero.' }
  }

  if (data.batchLabel && data.batchLabel.length > 80) {
    return { ok: false, error: 'Batch label must be 80 characters or fewer.' }
  }
  return { ok: true }
}

export function createProductCostService(sql: NeonQueryFunction<false, false>) {
  return {
    async listCostBatches(): Promise<CostBatchRow[]> {
      const rows = await sql`
        SELECT
          b.id, b.product_id AS "productId", b.variant_id AS "variantId",
          b.color_name AS "colorName", b.batch_label AS "batchLabel",
          b.manufacturing_cents AS "manufacturingCents",
          b.freight_cents       AS "freightCents",
          b.duties_cents        AS "dutiesCents",
          b.tariffs_cents       AS "tariffsCents",
          b.import_tax_cents    AS "importTaxCents",
          b.packaging_cents     AS "packagingCents",
          b.other_landed_cents  AS "otherLandedCents",
          b.unit_cogs_cents     AS "unitCogsCents",
          b.effective_from      AS "effectiveFrom",
          b.note, b.created_by AS "createdBy", b.created_at AS "createdAt",
          p.name  AS "productName",
          pv.sku  AS "variantSku"
        FROM product_cost_batches b
        JOIN products p ON p.id = b.product_id
        LEFT JOIN product_variants pv ON pv.id = b.variant_id
        ORDER BY b.effective_from DESC, b.created_at DESC
      `
      return (rows as any[]).map(r => ({
        ...r,
        effectiveFrom: String(r.effectiveFrom).slice(0, 10),
        createdAt:     new Date(r.createdAt).toISOString(),
      })) as CostBatchRow[]
    },

    async createCostBatch(input: CostBatchInput, actorEmail: string): Promise<CostBatchRow> {
      const rows = await sql`
        INSERT INTO product_cost_batches (
          product_id, variant_id, color_name, batch_label,
          manufacturing_cents, freight_cents, duties_cents,
          tariffs_cents, import_tax_cents, packaging_cents, other_landed_cents,
          effective_from, note, created_by
        ) VALUES (
          ${input.productId}::uuid,
          ${input.variantId ?? null}::uuid,
          ${input.colorName ?? null},
          ${input.batchLabel ?? null},
          ${input.manufacturingCents ?? 0},
          ${input.freightCents ?? 0},
          ${input.dutiesCents ?? 0},
          ${input.tariffsCents ?? 0},
          ${input.importTaxCents ?? 0},
          ${input.packagingCents ?? 0},
          ${input.otherLandedCents ?? 0},
          ${input.effectiveFrom}::date,
          ${input.note ?? null},
          ${actorEmail}
        )
        RETURNING id, unit_cogs_cents AS "unitCogsCents", created_at AS "createdAt"
      `
      const created = (rows as any[])[0]
      return {
        ...input,
        id:            created.id,
        unitCogsCents: Number(created.unitCogsCents),
        productName:   null,
        variantSku:    null,
        createdBy:     actorEmail,
        createdAt:     new Date(created.createdAt).toISOString(),
      } as CostBatchRow
    },

    /**
     * Current effective cost per variant, using the same precedence as the SQL
     * resolve_cost_batch function: variant > colour > product default.
     * Used by the admin coverage view to show which SKUs still have no cost.
     */
    async getCurrentCostCoverage(): Promise<Array<{
      variantId: string
      sku: string
      productName: string
      colorName: string
      size: string
      unitCogsCents: number | null
      batchLabel: string | null
      source: 'variant' | 'color' | 'product' | null
    }>> {
      const rows = await sql`
        SELECT
          pv.id AS "variantId", pv.sku, pv.color_name AS "colorName", pv.size,
          p.name AS "productName",
          b.unit_cogs_cents AS "unitCogsCents",
          b.batch_label     AS "batchLabel",
          CASE
            WHEN b.variant_id IS NOT NULL THEN 'variant'
            WHEN b.color_name IS NOT NULL THEN 'color'
            WHEN b.id         IS NOT NULL THEN 'product'
            ELSE NULL
          END AS "source"
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN LATERAL (
          SELECT * FROM product_cost_batches cb
          WHERE cb.effective_from <= CURRENT_DATE
            AND (
              cb.variant_id = pv.id
              OR (cb.variant_id IS NULL AND cb.color_name = pv.color_name AND cb.product_id = pv.product_id)
              OR (cb.variant_id IS NULL AND cb.color_name IS NULL          AND cb.product_id = pv.product_id)
            )
          ORDER BY
            CASE WHEN cb.variant_id IS NOT NULL THEN 0
                 WHEN cb.color_name IS NOT NULL THEN 1
                 ELSE 2 END,
            cb.effective_from DESC, cb.created_at DESC
          LIMIT 1
        ) b ON TRUE
        WHERE pv.active = TRUE
        ORDER BY p.name, pv.color_name, pv.size_sort
      `
      return (rows as any[]).map(r => ({
        variantId:     r.variantId,
        sku:           r.sku,
        productName:   r.productName,
        colorName:     r.colorName,
        size:          r.size,
        unitCogsCents: r.unitCogsCents === null ? null : Number(r.unitCogsCents),
        batchLabel:    r.batchLabel ?? null,
        source:        r.source ?? null,
      }))
    },
  }
}

export type ProductCostService = ReturnType<typeof createProductCostService>
