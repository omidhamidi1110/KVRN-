// lib/media-usage.ts — keep media_usages truthful so Admin can show where an asset is used
// BEFORE any destructive action (archive/unlink preferred over hard delete).
//
// Contract for feature code (Product Editor, size guides, collections, pages, settings...):
//   after saving a DRAFT        → syncMediaUsages(sql, { ownerType, ownerId, scope: 'draft',     refs })
//   after PUBLISH / ROLLBACK    → syncMediaUsages(sql, { ownerType, ownerId, scope: 'published', refs })
//   after unpublish / archive   → syncMediaUsages(sql, { ownerType, ownerId, scope: 'published', refs: [] })
// `refs` is the COMPLETE set of assets the owner references in that scope (sync is a replace).

type Sql = any

export interface MediaRef { slot: string; assetId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function syncMediaUsages(sql: Sql, a: {
  ownerType: string; ownerId: string; scope: 'draft' | 'published'; refs: MediaRef[]
}): Promise<void> {
  const refs = a.refs.filter(r => r && UUID_RE.test(r.assetId) && r.slot)
  const slots = refs.map(r => r.slot)
  const ids = refs.map(r => r.assetId)
  // 1) drop usages no longer referenced
  await sql`
    DELETE FROM media_usages
     WHERE owner_type = ${a.ownerType} AND owner_id = ${a.ownerId} AND scope = ${a.scope}
       AND (asset_id::text, slot) NOT IN (SELECT * FROM UNNEST(${ids}::text[], ${slots}::text[]))`
  // 2) add new ones (missing assets are ignored by the FK check below)
  if (refs.length) {
    await sql`
      INSERT INTO media_usages (asset_id, owner_type, owner_id, slot, scope)
      SELECT x.asset_id::uuid, ${a.ownerType}, ${a.ownerId}, x.slot, ${a.scope}
        FROM UNNEST(${ids}::text[], ${slots}::text[]) AS x(asset_id, slot)
        JOIN media_assets m ON m.id = x.asset_id::uuid
      ON CONFLICT (asset_id, owner_type, owner_id, slot, scope) DO NOTHING`
  }
}

export async function listMediaUsages(sql: Sql, assetId: string) {
  return await sql`
    SELECT owner_type, owner_id, slot, scope FROM media_usages
     WHERE asset_id = ${assetId} ORDER BY owner_type, owner_id, slot` as Array<{ owner_type: string; owner_id: string; slot: string; scope: string }>
}

/** Assets an owner cannot publish with: missing or archived. Returns the offending ids. */
export async function findUnusableAssets(sql: Sql, assetIds: string[]): Promise<string[]> {
  const ids = assetIds.filter(i => UUID_RE.test(i))
  if (!ids.length) return []
  const ok = await sql`SELECT id::text FROM media_assets WHERE id = ANY(${ids}::uuid[]) AND status = 'active'` as Array<{ id: string }>
  const good = new Set(ok.map(r => r.id))
  return ids.filter(i => !good.has(i))
}
