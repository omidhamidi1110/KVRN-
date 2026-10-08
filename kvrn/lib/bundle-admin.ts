// lib/bundle-admin.ts — Admin-side reads for the Product Editor's bundle section (server only).
//
// Read-only: lists the products a set can include, with canonical price and live availability, and
// runs the database's own publish check (bundle_blockers) so the editor shows exactly what publish
// would enforce. Writes go through the normal product draft/publish lifecycle (nothing here mutates).
import { isUuid } from './bundle-ids'

type Sql = any

export interface BundleCandidate {
  id: string
  name: string
  productCode: string | null
  /** content_entities.status */
  status: string
  /** Canonical price in cents; null when the product has none yet. */
  priceCents: number | null
  variants: Array<{ id: string; sku: string; size: string; colorName: string; active: boolean; available: number }>
}

export async function listBundleCandidates(sql: Sql, opts: { exclude?: string | null; q?: string | null; limit?: number } = {}): Promise<BundleCandidate[]> {
  const exclude = opts.exclude && isUuid(opts.exclude) ? opts.exclude.toLowerCase() : null
  const q = (opts.q ?? '').trim().slice(0, 100)
  const like = q ? `%${q.replace(/[%_\\]/g, m => '\\' + m)}%` : null
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 100)
  const rows = await sql`
    SELECT p.id::text AS id, p.product_code, p.price_cents, e.status,
           COALESCE(v.snapshot->>'name', p.name) AS name
      FROM content_entities e
      JOIN products p ON p.id::text = e.entity_id
      LEFT JOIN content_versions v ON v.entity_type = e.entity_type AND v.entity_id = e.entity_id
            AND v.version_no = COALESCE(e.published_version_no, e.draft_version_no)
     WHERE e.entity_type = 'product' AND e.status <> 'archived'
       AND (${exclude}::text IS NULL OR e.entity_id <> ${exclude}::text)
       AND (${like}::text IS NULL OR COALESCE(v.snapshot->>'name', p.name) ILIKE ${like}::text OR p.product_code ILIKE ${like}::text)
     ORDER BY name
     LIMIT ${limit}` as any[]
  if (!rows.length) return []
  const ids = rows.map(r => r.id)
  const vs = await sql`
    SELECT product_id::text AS product_id, id::text AS id, sku, size, color_name, active,
           GREATEST(0, stock_on_hand - reserved_quantity)::int AS available
      FROM product_variants WHERE product_id = ANY(${ids}::uuid[]) ORDER BY size_sort, sku` as any[]
  const by: Record<string, BundleCandidate['variants']> = {}
  for (const v of vs) (by[v.product_id] ??= []).push({ id: v.id, sku: v.sku, size: v.size, colorName: v.color_name, active: !!v.active, available: Number(v.available) })
  return rows.map(r => ({
    id: r.id, name: r.name, productCode: r.product_code ?? null, status: r.status,
    priceCents: Number(r.price_cents) > 0 ? Number(r.price_cents) : null, variants: by[r.id] ?? [],
  }))
}

/** The database's publish check for a snapshot's bundle ([] when absent/off, or before migration 029). */
export async function bundleIssuesFor(
  sql: Sql, productId: string, snapshot: unknown, useSnapshotPrice: boolean,
): Promise<Array<{ code: string; field: string; message: string }>> {
  const enabled = (snapshot as any)?.bundle?.enabled === true
  if (!enabled) return []
  try {
    const rows = await sql`SELECT bundle_blockers(${productId}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${useSnapshotPrice}) AS r` as any[]
    const r = rows[0]?.r
    return Array.isArray(r) ? r : []
  } catch (e: any) {
    // Migration 029 not applied: there can be no live bundle, so there is nothing to block.
    if (e?.code === '42883' || /bundle_blockers/.test(String(e?.message)) && /does not exist/.test(String(e?.message))) return []
    throw e
  }
}
