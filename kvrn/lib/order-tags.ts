// lib/order-tags.ts — internal order tags (Hold, VIP, UGC, Replacement, Manual Review, ...).
//
// INTERNAL ONLY. Tags are an organisation aid for the owner. They are never rendered in any
// customer e-mail, customer page or public API, and they NEVER change payment, accounting,
// inventory or fulfillment. In particular a tag named "Hold" is just a label: the server-enforced
// fraud fulfillment hold is a separate state (lib/fraud-review.ts, table order_fraud_reviews).
//
// Every mutation goes through an atomic SQL function (migration 031) that also writes
// admin_audit_logs, so a change and its audit row commit or fail together.
//
// This module is import-safe from client code: it has no runtime dependency on the server.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export const ORDER_TAG_COLORS = ['neutral', 'red', 'amber', 'green', 'blue', 'violet'] as const
export type OrderTagColor = (typeof ORDER_TAG_COLORS)[number]

export const ORDER_TAG_NAME_MAX = 32
export const ORDER_TAGS_PER_ORDER_MAX = 10

export interface OrderTag {
  id:       string
  name:     string
  color:    OrderTagColor
  archived: boolean
  /** Number of orders carrying this tag (list endpoint only). */
  orderCount?: number
}

/** The compact form shown as a chip in the Orders list and detail. */
export interface OrderTagChip {
  id:    string
  name:  string
  color: OrderTagColor
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Validation (server-side; the database re-validates) ─────────────────────────────────────

/** Trim, collapse inner whitespace, bound the length, refuse control characters. */
export function normalizeTagName(raw: unknown):
  { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'A tag name is required.' }
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, error: 'A tag name is required.' }
  if (name.length > ORDER_TAG_NAME_MAX) {
    return { ok: false, error: `Tag names can be at most ${ORDER_TAG_NAME_MAX} characters.` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'The tag name contains control characters.' }
  return { ok: true, name }
}

export function normalizeTagColor(raw: unknown):
  { ok: true; color: OrderTagColor } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, color: 'neutral' }
  if (typeof raw === 'string' && (ORDER_TAG_COLORS as readonly string[]).includes(raw)) {
    return { ok: true, color: raw as OrderTagColor }
  }
  return { ok: false, error: 'Choose one of the listed tag colors.' }
}

// ── Database error codes (KVRN_TAG|CODE|detail) -> HTTP ──────────────────────────────────────

export const TAG_ERRORS: Record<string, { status: number; message: string }> = {
  NAME_REQUIRED:   { status: 400, message: 'A tag name is required.' },
  NAME_TOO_LONG:   { status: 400, message: `Tag names can be at most ${ORDER_TAG_NAME_MAX} characters.` },
  NAME_INVALID:    { status: 400, message: 'The tag name contains control characters.' },
  COLOR_INVALID:   { status: 400, message: 'Choose one of the listed tag colors.' },
  TAG_REQUIRED:    { status: 400, message: 'A tag and an order are required.' },
  ACTOR_REQUIRED:  { status: 400, message: 'An admin identity is required.' },
  ACTOR_INVALID:   { status: 400, message: 'The admin identity is invalid.' },
  TAG_NOT_FOUND:   { status: 404, message: 'Tag not found.' },
  ORDER_NOT_FOUND: { status: 404, message: 'Order not found.' },
  DUPLICATE:       { status: 409, message: 'A tag with this name already exists.' },
  IN_USE:          { status: 409, message: 'This tag is on one or more orders. Archive it instead of deleting it.' },
  TAG_ARCHIVED:    { status: 409, message: 'This tag is archived. Restore it before using it.' },
  TOO_MANY:        { status: 409, message: `An order can have at most ${ORDER_TAGS_PER_ORDER_MAX} tags.` },
}

export class OrderTagError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}

/** Map a database exception to an OrderTagError; anything unrecognised is re-thrown unchanged. */
export function mapTagDbError(err: unknown): never {
  const m = /KVRN_TAG\|([A-Z_]+)/.exec(String((err as any)?.message ?? ''))
  if (m) {
    const known = TAG_ERRORS[m[1]]
    if (known) throw new OrderTagError(m[1], known.status, known.message)
  }
  throw err
}

// ── Service ──────────────────────────────────────────────────────────────────────────────────

type Sql = NeonQueryFunction<false, false>

export function createOrderTagService(sql: Sql) {
  const rowToTag = (r: any): OrderTag => ({
    id: r.id, name: r.name, color: r.color, archived: r.archived_at !== null && r.archived_at !== undefined,
    ...(r.order_count !== undefined ? { orderCount: Number(r.order_count) } : {}),
  })

  return {
    /** All tags (archived last). `includeArchived=false` is for the picker. */
    async listTags(opts: { includeArchived?: boolean } = {}): Promise<OrderTag[]> {
      const includeArchived = opts.includeArchived !== false
      const rows = await sql`
        SELECT t.id, t.name, t.color, t.archived_at,
               (SELECT COUNT(*) FROM order_tag_assignments a WHERE a.tag_id = t.id)::int AS order_count
        FROM order_tags t
        WHERE ${includeArchived}::boolean OR t.archived_at IS NULL
        ORDER BY (t.archived_at IS NOT NULL), lower(t.name)
      `
      return (rows as any[]).map(rowToTag)
    },

    async getTag(id: string): Promise<OrderTag | null> {
      const rows = await sql`SELECT id, name, color, archived_at FROM order_tags WHERE id = ${id}::uuid`
      return rows[0] ? rowToTag(rows[0]) : null
    },

    async createTag(name: string, color: OrderTagColor, actorEmail: string): Promise<OrderTag> {
      try {
        const rows = await sql`SELECT order_tag_create(${name}, ${color}, ${actorEmail}) AS r`
        const r = (rows[0] as any).r
        return { id: r.id, name: r.name, color: r.color, archived: false }
      } catch (e) { return mapTagDbError(e) }
    },

    async updateTag(
      id: string,
      patch: { name?: string; color?: OrderTagColor; archived?: boolean },
      actorEmail: string,
    ): Promise<OrderTag & { outcome: string }> {
      try {
        const rows = await sql`
          SELECT order_tag_update(${id}::uuid, ${patch.name ?? null}, ${patch.color ?? null},
                                  ${patch.archived ?? null}::boolean, ${actorEmail}) AS r`
        const r = (rows[0] as any).r
        return { id: r.id, name: r.name, color: r.color, archived: !!r.archived, outcome: r.outcome }
      } catch (e) { return mapTagDbError(e) }
    },

    async deleteTag(id: string, actorEmail: string): Promise<void> {
      try {
        await sql`SELECT order_tag_delete(${id}::uuid, ${actorEmail}) AS r`
      } catch (e) { return mapTagDbError(e) }
    },

    async assign(orderId: string, tagId: string, actorEmail: string): Promise<'assigned' | 'already_assigned'> {
      try {
        const rows = await sql`SELECT order_tag_assign(${orderId}::uuid, ${tagId}::uuid, ${actorEmail}) AS r`
        return (rows[0] as any).r.outcome
      } catch (e) { return mapTagDbError(e) }
    },

    async remove(orderId: string, tagId: string, actorEmail: string): Promise<'removed' | 'not_assigned'> {
      try {
        const rows = await sql`SELECT order_tag_remove(${orderId}::uuid, ${tagId}::uuid, ${actorEmail}) AS r`
        return (rows[0] as any).r.outcome
      } catch (e) { return mapTagDbError(e) }
    },

    /** Tags of one order (chips), archived tags included so history stays visible. */
    async tagsForOrder(orderId: string): Promise<OrderTagChip[]> {
      const rows = await sql`
        SELECT t.id, t.name, t.color FROM order_tag_assignments a
        JOIN order_tags t ON t.id = a.tag_id
        WHERE a.order_id = ${orderId}::uuid ORDER BY a.assigned_at, lower(t.name)`
      return rows as OrderTagChip[]
    },

    /** Tags for many orders in ONE query: orderId -> chips. */
    async tagsForOrders(orderIds: string[]): Promise<Map<string, OrderTagChip[]>> {
      const out = new Map<string, OrderTagChip[]>()
      if (orderIds.length === 0) return out
      const rows = await sql`
        SELECT a.order_id AS "orderId", t.id, t.name, t.color
        FROM order_tag_assignments a JOIN order_tags t ON t.id = a.tag_id
        WHERE a.order_id = ANY(${orderIds}::uuid[]) ORDER BY a.assigned_at, lower(t.name)`
      for (const r of rows as any[]) {
        const list = out.get(r.orderId) ?? []
        list.push({ id: r.id, name: r.name, color: r.color })
        out.set(r.orderId, list)
      }
      return out
    },
  }
}

export type OrderTagService = ReturnType<typeof createOrderTagService>
