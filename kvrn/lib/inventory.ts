// lib/inventory.ts — server-side inventory and price validation
// This file is server-only. Never import into client components.

import { sql, type ProductVariant } from './db'

export type ValidationError =
  | 'INVALID_SKU'
  | 'INVALID_QUANTITY'
  | 'INACTIVE_VARIANT'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'PRICE_NOT_CONFIGURED'

export type ValidationResult =
  | { ok: true;  variant: ProductVariant & { price_cents: number; product_name: string } }
  | { ok: false; error: ValidationError; message: string }

const MAX_QUANTITY_PER_ITEM = 10

export async function validateLineItem(
  sku: string,
  quantity: number
): Promise<ValidationResult> {
  // Quantity must be a positive integer
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: 'INVALID_QUANTITY', message: 'Quantity must be a whole number of at least 1.' }
  }
  if (quantity > MAX_QUANTITY_PER_ITEM) {
    return { ok: false, error: 'INVALID_QUANTITY', message: `Maximum ${MAX_QUANTITY_PER_ITEM} per item.` }
  }

  const rows = await sql`
    SELECT
      pv.*,
      (pv.stock_on_hand - pv.reserved_quantity) AS available_quantity,
      p.name   AS product_name,
      p.slug   AS product_slug,
      p.price_cents,
      p.active AS product_active
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.sku = ${sku}
    LIMIT 1
  `
  if (rows.length === 0) {
    return { ok: false, error: 'INVALID_SKU', message: 'Product not found.' }
  }

  const v = rows[0] as any
  if (!v.product_active || !v.active) {
    return { ok: false, error: 'INACTIVE_VARIANT', message: 'This item is no longer available.' }
  }
  if (!v.price_cents || v.price_cents <= 0) {
    return { ok: false, error: 'PRICE_NOT_CONFIGURED', message: 'Pricing error. Please contact support.' }
  }
  const available = Number(v.available_quantity)
  if (available <= 0) {
    return { ok: false, error: 'OUT_OF_STOCK', message: `${v.size} is sold out.` }
  }
  if (available < quantity) {
    return { ok: false, error: 'INSUFFICIENT_STOCK', message: `Only ${available} available in ${v.size}.` }
  }

  return { ok: true, variant: { ...v, available_quantity: available } }
}

/** Fetch all variant availability for a product slug (for public PDP) */
export async function getVariantAvailability(productSlug: string) {
  const rows = await sql`
    SELECT
      pv.sku,
      pv.size,
      pv.size_sort,
      pv.color_code,
      pv.active,
      (pv.stock_on_hand - pv.reserved_quantity) AS available_quantity
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE p.slug = ${productSlug} AND p.active = true
    ORDER BY pv.size_sort ASC
  `
  return rows as Array<{
    sku: string; size: string; size_sort: number;
    color_code: string; active: boolean; available_quantity: number
  }>
}

/** Fetch all variants for admin dashboard */
export async function getAllVariantsForAdmin() {
  const rows = await sql`
    SELECT
      pv.*,
      (pv.stock_on_hand - pv.reserved_quantity) AS available_quantity,
      p.name  AS product_name,
      p.slug  AS product_slug
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    ORDER BY p.drop_code, p.product_code, pv.size_sort
  `
  return rows
}

/** Adjust stock — returns the updated variant */
export async function adjustStock(opts: {
  variantId:    string
  type:         'SET' | 'ADD' | 'REMOVE'
  quantity:     number
  reason:       string
  note?:        string
  actorEmail:   string
}): Promise<{ success: true; variant: any } | { success: false; error: string }> {
  const { variantId, type, quantity, reason, note, actorEmail } = opts

  if (!Number.isInteger(quantity) || quantity < 0) {
    return { success: false, error: 'Quantity must be a non-negative integer.' }
  }

  try {
    // Fetch current variant
    const rows = await sql`SELECT * FROM product_variants WHERE id = ${variantId} LIMIT 1`
    if (rows.length === 0) return { success: false, error: 'Variant not found.' }
    const variant = rows[0] as any

    let newStock: number
    let delta: number

    if (type === 'SET') {
      newStock = quantity; delta = quantity - Number(variant.stock_on_hand)
    } else if (type === 'ADD') {
      newStock = Number(variant.stock_on_hand) + quantity; delta = quantity
    } else {
      newStock = Number(variant.stock_on_hand) - quantity; delta = -quantity
    }

    if (newStock < 0) return { success: false, error: 'Cannot reduce stock below zero.' }
    if (newStock < Number(variant.reserved_quantity)) {
      return { success: false, error: 'Cannot reduce stock below reserved quantity.' }
    }

    const [updated] = await sql`
      UPDATE product_variants SET stock_on_hand = ${newStock}, updated_at = NOW()
      WHERE id = ${variantId} RETURNING *
    `
    await sql`
      INSERT INTO inventory_movements (variant_id, quantity_delta, movement_type, reason, note, actor_email)
      VALUES (${variantId}, ${delta}, ${type}, ${reason}, ${note ?? null}, ${actorEmail})
    `
    await sql`
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      VALUES (${actorEmail}, ${'INVENTORY_' + type}, 'product_variants', ${variantId},
              ${JSON.stringify({ delta, newStock, reason, note })}::jsonb)
    `
    return { success: true, variant: updated }
  } catch (err: any) {
    return { success: false, error: err.message ?? 'Unknown error.' }
  }
}

/** Toggle variant active status */
export async function setVariantActive(variantId: string, active: boolean, actorEmail: string) {
  await sql`UPDATE product_variants SET active=${active}, updated_at=NOW() WHERE id=${variantId}`
  await sql`
    INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
    VALUES (${actorEmail}, ${active ? 'ACTIVATE_VARIANT' : 'DEACTIVATE_VARIANT'},
            'product_variants', ${variantId}, ${JSON.stringify({ active })}::jsonb)
  `
}

/** Recent inventory movements for a variant */
export async function getRecentMovements(variantId: string, limit = 20) {
  return sql`
    SELECT * FROM inventory_movements
    WHERE variant_id = ${variantId}
    ORDER BY created_at DESC LIMIT ${limit}
  `
}

// ── Shipping data for Shippo rate calculations ────────────────────────────────

export interface ProductShippingData {
  productCode:     string  // e.g. 'PKHH', 'PKHSP'
  garmentWeightLb: number  // garment weight only — packaging weight added separately per parcel
  lengthIn:        number  // parcel length in inches (mailer dimension)
  widthIn:         number  // parcel width in inches (mailer dimension)
  heightIn:        number  // packed height estimate — configurable via DB, update when measured
}

/**
 * Fetch authoritative packed shipping dimensions from the products table.
 * Returns only products that have all four shipping fields populated.
 * Server-side only — used by Shippo rate calculation.
 */
export async function getProductShippingData(): Promise<ProductShippingData[]> {
  const rows = await sql`
    SELECT
      product_code         AS "productCode",
      shipping_weight_lb   AS "shippingWeightLb",
      package_length_in    AS "lengthIn",
      package_width_in     AS "widthIn",
      package_height_in    AS "heightIn"
    FROM products
    WHERE shipping_weight_lb IS NOT NULL
      AND package_length_in  IS NOT NULL
      AND package_width_in   IS NOT NULL
      AND package_height_in  IS NOT NULL
    ORDER BY product_code
  `
  return (rows as any[]).map(r => ({
    productCode:      r.productCode,
    garmentWeightLb:  Number(r.shippingWeightLb),
    lengthIn:         Number(r.lengthIn),
    widthIn:          Number(r.widthIn),
    heightIn:         Number(r.heightIn),
  }))
}
