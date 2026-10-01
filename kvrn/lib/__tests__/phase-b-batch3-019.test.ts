// lib/__tests__/phase-b-batch3-019.test.ts
// Migration 019: FIFO inventory cost layers.
//
// The authoritative validation for this migration is the real PostgreSQL
// apply-and-execute run (see the batch report). These tests guard the contract
// and the invariants that must not silently regress.

const fs   = require('fs')
const path = require('path')

const M017 = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/017_finalize_cogs_snapshot.sql'), 'utf8')
const M019 = fs.readFileSync(
  path.join(__dirname, '../../db/migrations/019_inventory_fifo_layers.sql'), 'utf8')

/** Strip SQL comments so prose about a rule cannot satisfy a test of that rule. */
const ddl = M019.split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n')

const fn017 = M017.slice(M017.indexOf('CREATE OR REPLACE FUNCTION finalize_paid_order'))
const fn019Start = ddl.indexOf('CREATE OR REPLACE FUNCTION finalize_paid_order')
// Bounded to the function body. Beyond it lies the opening-balance block, which
// legitimately still uses resolve_cost_batch to value incoming stock.
const fn019 = ddl.slice(fn019Start, ddl.indexOf('\n$$;', fn019Start))

// ─────────────────────────────────────────────────────────────────────────────
// FIFO COSTING SEMANTICS (pure model, mirrors consume_inventory_fifo)
// ─────────────────────────────────────────────────────────────────────────────

interface Layer { id: string; remaining: number; unitCost: number | null }

/**
 * Mirrors consume_inventory_fifo: oldest layer first, never raises on shortage,
 * and returns NULL total unless EVERY unit had a known cost.
 */
function consumeFifo(layers: Layer[], qty: number) {
  let remaining = qty
  let knownCost = 0, knownQty = 0, unknownQty = 0, uncovered = 0
  for (const l of layers) {
    if (remaining <= 0) break
    if (l.remaining <= 0) continue
    const take = Math.min(l.remaining, remaining)
    l.remaining -= take
    if (l.unitCost === null) unknownQty += take
    else { knownQty += take; knownCost += l.unitCost * take }
    remaining -= take
  }
  if (remaining > 0) uncovered = remaining
  return {
    knownCost, knownQty, unknownQty, uncovered,
    totalCost: unknownQty === 0 && uncovered === 0 ? knownCost : null,
  }
}

describe('FIFO consumption semantics', () => {

  test('a sale entirely within one layer costs at that layer', () => {
    const layers: Layer[] = [{ id: 'a', remaining: 20, unitCost: 2500 }]
    expect(consumeFifo(layers, 10).totalCost).toBe(25000)
    expect(layers[0].remaining).toBe(10)
  })

  test('a sale spanning two known layers blends them oldest-first', () => {
    // The scenario the whole migration exists for: 20@$25 then 20@$32 must not
    // all be valued at $32 just because the newer batch exists.
    const layers: Layer[] = [
      { id: 'a', remaining: 10, unitCost: 2500 },
      { id: 'b', remaining: 20, unitCost: 3200 },
    ]
    expect(consumeFifo(layers, 15).totalCost).toBe(10 * 2500 + 5 * 3200)
    expect(layers[0].remaining).toBe(0)
    expect(layers[1].remaining).toBe(15)
  })

  test('oldest layer is drained before the newer one', () => {
    const layers: Layer[] = [
      { id: 'old', remaining: 5, unitCost: 1000 },
      { id: 'new', remaining: 5, unitCost: 9999 },
    ]
    expect(consumeFifo(layers, 5).totalCost).toBe(5000)
    expect(layers[1].remaining).toBe(5)
  })

  test('an unknown-cost layer yields NULL, never zero', () => {
    const layers: Layer[] = [{ id: 'a', remaining: 10, unitCost: null }]
    const r = consumeFifo(layers, 5)
    expect(r.totalCost).toBeNull()
    expect(r.unknownQty).toBe(5)
    expect(r.knownCost).toBe(0)   // known portion is 0, but total is NOT 0
  })

  test('mixing known and unknown makes the whole line unknown', () => {
    // A partial cost must never masquerade as a full one.
    const layers: Layer[] = [
      { id: 'a', remaining: 3, unitCost: null },
      { id: 'b', remaining: 10, unitCost: 2000 },
    ]
    const r = consumeFifo(layers, 8)
    expect(r.totalCost).toBeNull()
    expect(r.knownQty).toBe(5)
    expect(r.unknownQty).toBe(3)
  })

  test('a shortage records uncovered quantity and never throws', () => {
    const layers: Layer[] = [{ id: 'a', remaining: 3, unitCost: 1000 }]
    const r = consumeFifo(layers, 10)
    expect(r.uncovered).toBe(7)
    expect(r.knownQty).toBe(3)
    expect(r.totalCost).toBeNull()
  })

  test('quantity always reconciles even on shortage', () => {
    const layers: Layer[] = [
      { id: 'a', remaining: 2, unitCost: 100 },
      { id: 'b', remaining: 2, unitCost: null },
    ]
    const r = consumeFifo(layers, 10)
    expect(r.knownQty + r.unknownQty + r.uncovered).toBe(10)
  })

  test('a zero or negative quantity is a no-op', () => {
    const layers: Layer[] = [{ id: 'a', remaining: 5, unitCost: 100 }]
    expect(consumeFifo(layers, 0).totalCost).toBe(0)
    expect(layers[0].remaining).toBe(5)
  })

  test('exhausted layers are skipped', () => {
    const layers: Layer[] = [
      { id: 'a', remaining: 0, unitCost: 100 },
      { id: 'b', remaining: 5, unitCost: 200 },
    ]
    expect(consumeFifo(layers, 3).totalCost).toBe(600)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RESERVATION ISOLATION — the invariant that makes FIFO safe here
// ─────────────────────────────────────────────────────────────────────────────

describe('reservations never touch cost layers', () => {

  test('no reservation function consumes or reserves layers', () => {
    // stock_on_hand is physical on-hand including reserved-but-unpaid units, so
    // layers mirror it and reservations must leave them alone. Consumption
    // happens only at the paid DEDUCT point.
    for (const fname of ['reserve_inventory', 'release_expired_reservations']) {
      const src = fs.readFileSync(
        path.join(__dirname, '../../db/migrations/002_reservations_orders_v49.sql'), 'utf8')
      if (src.includes(fname)) {
        expect(src).not.toContain('consume_inventory_fifo')
        expect(src).not.toContain('inventory_cost_layers')
      }
    }
  })

  test('019 adds no layer logic to any reservation path', () => {
    expect(ddl).not.toContain('FUNCTION reserve_inventory')
    expect(ddl).not.toContain('FUNCTION release_expired_reservations')
  })

  test('FIFO consumption is atomic with the stock decrement', () => {
    // Same function body, therefore same transaction: quantity and cost cannot
    // diverge even if the process dies mid-order.
    const deductIdx = fn019.indexOf('stock_on_hand=stock_on_hand-v_item.quantity')
    const fifoIdx   = fn019.indexOf('consume_inventory_fifo(')
    expect(deductIdx).toBeGreaterThan(0)
    expect(fifoIdx).toBeGreaterThan(deductIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// finalize_paid_order PRESERVATION AUDIT
// ─────────────────────────────────────────────────────────────────────────────

describe('finalize_paid_order preserves every 017 behaviour', () => {

  test('the 11-argument signature is unchanged', () => {
    for (const p of ['p_stripe_session_id', 'p_reservation_id_hint', 'p_stripe_payment_intent',
                     'p_stripe_event_id', 'p_event_type', 'p_expected_currency', 'p_amount_total',
                     'p_customer_email', 'p_customer_name', 'p_customer_phone', 'p_shipping_address']) {
      expect(fn019).toContain(p)
    }
  })

  test.each([
    ['webhook idempotency lock',   'ON CONFLICT (stripe_event_id) DO NOTHING'],
    ['already-processed path',     'already_processed'],
    ['already-had-order path',     'already_had_order'],
    ['no-reservation path',        'no_reservation'],
    ['eligibility check',          'reservation_not_eligible'],
    ['currency guard',             'KVRN_RESERVATION|CURRENCY_MISMATCH'],
    ['amount invariant',           'KVRN_RESERVATION|AMOUNT_MISMATCH'],
    ['deduct invariant',           'KVRN_RESERVATION|DEDUCT_INVARIANT'],
    ['limited-code guard',         'KVRN_DISCOUNT|NO_CLAIM_FOR_LIMITED_CODE'],
    ['discount subtracted once',   'GREATEST(0, v_merch_total - v_discount_cents) + v_ship_final'],
    ['redemption idempotency',     'ON CONFLICT (discount_id, order_id) DO NOTHING'],
    ['redemption counter',         'redemption_count = redemption_count + 1'],
    ['email outbox idempotency',   'ON CONFLICT (order_id, email_type) DO NOTHING'],
    ['reservation completion',     "status='completed', completed_at=NOW()"],
    ['stock guard',                'stock_on_hand>=v_item.quantity AND reserved_quantity>=v_item.quantity'],
    ['order numbering',            "nextval('order_number_seq')"],
  ])('%s is byte-identical to 017', (_label, token) => {
    const in017 = (fn017.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    const in019 = (fn019.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    expect(in019).toBe(in017)
    expect(in019).toBeGreaterThan(0)
  })

  test('the ONLY costing change: resolve_cost_batch is gone from finalize', () => {
    expect(fn017).toContain('resolve_cost_batch')
    expect(fn019).not.toContain('resolve_cost_batch')
    expect(fn019).toContain('consume_inventory_fifo')
  })

  test('resolve_cost_batch still serves opening balance and manual adjustments', () => {
    // Removed from the sale path only; it remains the source for valuing
    // incoming stock where no layer exists yet.
    expect(ddl).toContain('resolve_cost_batch')
  })

  test('unknown FIFO cost writes NULL COGS, never zero', () => {
    expect(fn019).toContain("WHEN (v_fifo->>'total_cost_cents') IS NULL THEN NULL")
  })

  test('no unrelated checkout behaviour was rewritten', () => {
    // Nothing about shipping, discounts or customer snapshots may change.
    for (const token of ['v_ship_before', 'v_ship_discount', 'v_ship_final',
                         'v_cust_email', 'v_cust_name', 'v_ship_addr', 'v_ship_method']) {
      expect(fn019).toContain(token)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN COST IS NEVER ZERO
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown cost is never zero', () => {

  test('layer cost is nullable', () => {
    expect(ddl).toContain('unit_landed_cost_cents INTEGER')
    expect(ddl).not.toContain('unit_landed_cost_cents INTEGER NOT NULL')
  })

  test('consumption cost is nullable', () => {
    expect(ddl).toContain('unit_cost_cents   INTEGER')
    expect(ddl).toContain('total_cost_cents  INTEGER')
  })

  test('a shortage is recorded rather than costed or thrown', () => {
    const fifo = ddl.slice(ddl.indexOf('FUNCTION consume_inventory_fifo'))
    expect(fifo).toContain("'uncovered'")
    // No exception on shortage — a paid order must never fail for bookkeeping.
    const shortageBlock = fifo.slice(fifo.indexOf('IF v_remaining > 0 THEN'),
                                     fifo.indexOf('RETURN jsonb_build_object'))
    expect(shortageBlock).not.toContain('RAISE EXCEPTION')
  })

  test('the total is NULL unless every unit had a known cost', () => {
    const fifo = ddl.slice(ddl.indexOf('FUNCTION consume_inventory_fifo'))
    expect(fifo).toContain('WHEN v_unknown_qty = 0 AND v_uncovered = 0 THEN v_known_cost ELSE NULL END')
  })

  test('an uncovered consumption cannot carry a cost', () => {
    expect(ddl).toContain('CONSTRAINT ilc_uncovered_has_no_layer')
  })

  test('valuation reports unknown units separately from value', () => {
    // Unknown quantity must not poison the known-value subtotal.
    const val = ddl.slice(ddl.indexOf('FUNCTION inventory_valuation'))
    expect(val).toContain('unknown_cost_units')
    expect(val).toContain('known_cost_units')
    expect(val).toContain('value_at_cost_cents')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ONE COSTING METHOD, ONE QUANTITY COUNTER
// ─────────────────────────────────────────────────────────────────────────────

describe('every stock-removal path uses the same primitive', () => {

  test.each([
    ['sale',        'FUNCTION finalize_paid_order'],
    ['write-off',   'FUNCTION record_inventory_write_off'],
    ['adjustment',  'FUNCTION adjust_inventory_with_layers'],
  ])('%s consumes FIFO', (_label, fname) => {
    const fn = ddl.slice(ddl.indexOf(fname))
    expect(fn.slice(0, fn.indexOf('$$;'))).toContain('consume_inventory_fifo')
  })

  test('all five consumption types are modelled', () => {
    for (const t of ['sale', 'write_off', 'promo', 'exchange_out', 'adjustment']) {
      expect(ddl).toContain(`'${t}'`)
    }
  })

  test('promotional use is distinguishable from loss', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION record_inventory_write_off'))
    expect(fn).toContain("p_reason IN ('sample','giveaway','influencer','photography','promotional')")
    expect(fn).toContain("THEN 'promo' ELSE 'write_off' END")
  })

  test('all nine write-off reasons are preserved', () => {
    for (const r of ['damaged','defective','lost','sample','giveaway',
                     'influencer','photography','promotional','other']) {
      expect(ddl).toContain(`'${r}'`)
    }
  })

  test('write-offs create no sales revenue', () => {
    const block = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS inventory_write_offs'),
                            ddl.indexOf('CREATE INDEX IF NOT EXISTS idx_iwo_variant'))
    expect(block).not.toContain('revenue')
    expect(block).not.toContain('unit_price')
  })

  test('no second physical quantity counter is introduced', () => {
    // units_remaining is a DECOMPOSITION of stock_on_hand, checked by an
    // explicit reconciliation function rather than trusted.
    expect(ddl).toContain('FUNCTION reconcile_inventory_layers')
    expect(ddl).toContain('layer_units_remaining <> v.stock_on_hand')
  })

  test('the manual adjustment path is atomic in SQL, not multi-statement TS', () => {
    const lib = fs.readFileSync(path.join(__dirname, '../inventory.ts'), 'utf8')
    expect(lib).toContain('adjust_inventory_with_layers')
    // The old non-transactional trio must be gone.
    expect(lib).not.toContain('UPDATE product_variants SET stock_on_hand = ${newStock}')
  })

  test('adjustment guards survive the move into SQL', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION adjust_inventory_with_layers'))
    expect(fn).toContain('KVRN_INVENTORY|BELOW_ZERO')
    expect(fn).toContain('KVRN_INVENTORY|BELOW_RESERVED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RETURNS AND RESTOCK
// ─────────────────────────────────────────────────────────────────────────────

describe('restock rules', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION restock_return_item'))

  test('only a sellable unit may restock', () => {
    expect(fn).toContain('KVRN_RETURN|NOT_SELLABLE')
  })

  test('restocking is idempotent', () => {
    expect(fn).toContain("'already_restocked'")
  })

  test('the layer is priced at the snapshotted COGS basis', () => {
    expect(fn).toContain('v_item.unit_cogs_cents_snapshot')
    expect(fn).toContain("'return_restock'")
  })

  test('an unknown snapshot yields an unknown layer, not zero', () => {
    expect(fn).toContain("WHEN v_item.unit_cogs_cents_snapshot IS NULL THEN 'unknown'")
  })

  test('the COGS credit equals the layer value exactly', () => {
    expect(fn).toContain('v_item.unit_cogs_cents_snapshot * v_item.quantity')
  })

  test('a COGS credit exists only for a genuine restock', () => {
    expect(fn).toContain('SET restocked = TRUE, restocked_at = NOW(), cogs_credit_cents = v_credit')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASES: CASH vs CAPITALISED COST
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory purchase cash never becomes an operating expense', () => {

  test('payments are a separate table from expense_transactions', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS inventory_purchase_payments')
  })

  test('paid_at is the authoritative cash date and is required', () => {
    expect(ddl).toContain('paid_at         DATE        NOT NULL')
  })

  test('a payment date is not a receipt date', () => {
    // Separate columns on separate tables; nothing derives one from the other.
    expect(ddl).toContain('received_at     DATE')
    const pay = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS inventory_purchase_payments'))
    expect(pay.slice(0, pay.indexOf('CREATE INDEX'))).not.toContain('received_at')
  })

  test('all capitalisable payment types are supported', () => {
    for (const t of ['deposit','partial','final','supplier','freight',
                     'duties','tariffs','customs_brokerage','other']) {
      expect(ddl).toContain(`'${t}'`)
    }
  })

  test('the recognition primitive never reads purchase payments', () => {
    // The same dollar must not be both capitalised inventory and opex.
    const calc = fs.readFileSync(path.join(__dirname, '../financial-calculator.ts'), 'utf8')
    expect(calc).not.toContain('inventory_purchase_payments')
    const fin = fs.readFileSync(path.join(__dirname, '../financials.ts'), 'utf8')
    const fetchFn = fin.slice(fin.indexOf('async function fetchExpenseRows'),
                              fin.indexOf('async function fetchAdSpendRows'))
    expect(fetchFn).not.toContain('inventory_purchase_payments')
    expect(fetchFn).toContain('FROM expense_transactions')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OPENING BALANCE AND MIGRATION SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('opening-balance cutover', () => {

  test('layers are seeded from physical stock', () => {
    expect(ddl).toContain("'opening_balance'")
    expect(ddl).toContain('WHERE pv.stock_on_hand > 0')
  })

  test('seeding is skipped where layers already exist', () => {
    expect(ddl).toContain('NOT EXISTS (\n        SELECT 1 FROM inventory_cost_layers l WHERE l.variant_id = pv.id')
  })

  test('cost is used only where one actually exists', () => {
    expect(ddl).toContain("WHEN v_batch.unit_cogs_cents IS NULL THEN 'unknown'")
  })

  test('provenance records this as a migration valuation', () => {
    for (const c of ['opening_cutover_at', 'cost_basis_source', 'is_migration_opening',
                     'cost_basis_note']) {
      expect(ddl).toContain(c)
    }
  })

  test('the migration states no pre-cutover FIFO history exists', () => {
    expect(M019).toContain('No pre-cutover FIFO history exists')
  })

  test('pre-cutover order COGS is never recomputed', () => {
    expect(ddl).not.toContain('UPDATE order_items SET unit_cogs_cents = NULL')
    expect(ddl).not.toContain('DELETE FROM order_items')
  })
})

describe('migration 019 safety', () => {

  test('it drops nothing', () => {
    expect(ddl).not.toContain('DROP TABLE')
    expect(ddl).not.toContain('DROP COLUMN')
    expect(ddl).not.toContain('DROP FUNCTION')
  })

  test('it is one transaction', () => {
    expect((M019.match(/^BEGIN;$/gm) ?? []).length).toBe(1)
    expect((M019.match(/^COMMIT;$/gm) ?? []).length).toBe(1)
  })

  test('all five tables are created idempotently', () => {
    for (const t of ['inventory_cost_layers','inventory_layer_consumptions',
                     'inventory_write_offs','inventory_purchases','inventory_purchase_payments']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${t}`)
    }
  })

  test('new columns are added conditionally', () => {
    expect(ddl).toContain("WHERE table_name = 'product_cost_batches' AND column_name = 'units_received'")
    expect(ddl).toContain("WHERE table_name = 'inventory_movements' AND column_name = 'return_id'")
  })

  test('it does not modify migrations 001-018', () => {
    expect(ddl).not.toContain('FUNCTION upsert_order_dispute')
    expect(ddl).not.toContain('FUNCTION allocate_return_refund')
    expect(ddl).not.toContain('FUNCTION record_order_refund')
  })

  test('every plpgsql function declares the variables it uses', () => {
    // The 018 Rev 8 failure mode: undeclared identifiers only PostgreSQL catches.
    // This is a cheap guard; the real gate is the live apply run.
    const re = /CREATE OR REPLACE FUNCTION (\w+)\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(M019)) !== null) {
      const body = M019.slice(m.index, M019.indexOf('\n$$;', m.index))
      if (!body.includes('DECLARE')) continue
      const decl = body.slice(body.indexOf('DECLARE'), body.indexOf('BEGIN'))
      // Catches both "DECLARE\n  v_x INT;" and the same-line "DECLARE v_x INT;"
      const declared = new Set((decl.match(/\bv_\w+/g) ?? []).map((x: string) => x.toLowerCase()))
      const used = new Set((body.slice(body.indexOf('BEGIN')).match(/\bv_\w+/g) ?? [])
        .map((x: string) => x.toLowerCase()))
      const missing = [...used].filter(u => !declared.has(u))
      expect({ fn: m[1], missing }).toEqual({ fn: m[1], missing: [] })
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LANDED-COST DERIVATION — cent-exact, no cents lost to integer division
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors derive_batch_unit_costs + create_layers_from_batch. */
function deriveBatch(totalCents: number, units: number) {
  const base = Math.floor(totalCents / units)
  const remainder = totalCents - base * units
  return {
    base, remainder,
    baseUnits: units - remainder,
    premiumUnits: remainder,
    premiumCost: base + 1,
    layerValue: (units - remainder) * base + remainder * (base + 1),
  }
}

describe('batch landed-cost totals reconcile exactly', () => {

  test('$100 freight across 3 units loses no cents', () => {
    // A single integer cannot do this: floor gives 9999, round gives 10002.
    const d = deriveBatch(10000, 3)
    expect(d.base).toBe(3333)
    expect(d.baseUnits).toBe(2)
    expect(d.premiumUnits).toBe(1)
    expect(d.layerValue).toBe(10000)
  })

  test('a single rounded per-unit figure would have lost money', () => {
    expect(Math.floor(10000 / 3) * 3).toBe(9999)    // 1c lost
    expect(Math.round(10000 / 7) * 7).toBe(10003)   // 3c invented
    // The split representation loses neither.
    expect(deriveBatch(10000, 3).layerValue).toBe(10000)
    expect(deriveBatch(10000, 7).layerValue).toBe(10000)
  })

  test('combined components with remainder cents reconcile', () => {
    // (2500 manufacturing + 150 packaging) x 7 + 10000 freight + 3333 duties + 1 tariff
    const total = (2500 + 150) * 7 + 10000 + 3333 + 1
    expect(total).toBe(31884)
    expect(deriveBatch(total, 7).layerValue).toBe(31884)
  })

  test('exhaustive: every total 1..2000 across 1..12 units reconciles', () => {
    for (let total = 1; total <= 2000; total++) {
      for (let units = 1; units <= 12; units++) {
        const d = deriveBatch(total, units)
        expect(d.layerValue).toBe(total)
        expect(d.baseUnits + d.premiumUnits).toBe(units)
        expect(d.baseUnits).toBeGreaterThanOrEqual(0)
        expect(d.premiumUnits).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('a total smaller than the unit count still reconciles', () => {
    const d = deriveBatch(1, 3)
    expect(d.base).toBe(0)
    expect(d.layerValue).toBe(1)   // 2 units at 0c + 1 unit at 1c
  })

  test('an evenly divisible total produces a single layer', () => {
    const d = deriveBatch(9000, 3)
    expect(d.remainder).toBe(0)
    expect(d.premiumUnits).toBe(0)
    expect(d.layerValue).toBe(9000)
  })

  test('the SQL derives rather than only documenting', () => {
    // The Rev-8 lesson: a comment claiming behaviour is not behaviour.
    expect(ddl).toContain('FUNCTION derive_batch_unit_costs')
    expect(ddl).toContain('FUNCTION receive_batch_units')
    expect(ddl).toContain('v_remainder  := v_grand - (v_unit_total * v_units)')
  })

  test('the layer split carries the remainder cents', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    expect(fn).toContain('v_base_cost + 1')
    expect(fn).toContain('premium_units')
  })

  test('mixed entry mode is rejected, not silently reconciled', () => {
    expect(ddl).toContain('KVRN_COST|MIXED_ENTRY_MODE')
  })

  test('re-derivation is idempotent, not a false mixed-mode error', () => {
    // The first derivation writes the per-unit columns; a second must not treat
    // its own output as operator-supplied contradiction.
    expect(ddl).toContain('landed_derived_at')
    expect(ddl).toContain('IF b.landed_derived_at IS NULL AND (')
  })

  test('per-unit entry mode still works unchanged', () => {
    expect(ddl).toContain("'per_unit_mode'")
  })

  test('historical snapshots are never recomputed by derivation', () => {
    const start = ddl.indexOf('FUNCTION derive_batch_unit_costs')
    const fn = ddl.slice(start, ddl.indexOf('\n$$;', start))
    expect(fn).not.toContain('order_items')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// EXCHANGE INVENTORY CONSUMPTION
// ═════════════════════════════════════════════════════════════════════════════

describe('exchange shipment consumes FIFO without creating revenue', () => {
  // Bounded to the function body; later functions legitimately touch order_items.
  const shipStart = ddl.indexOf('FUNCTION ship_exchange_items')
  const fn = ddl.slice(shipStart, ddl.indexOf('\n$$;', shipStart))

  test('it consumes layers with the exchange_out type', () => {
    expect(fn).toContain("'exchange_out'")
    expect(fn).toContain('consume_inventory_fifo(')
  })

  test('it creates an EXCHANGE_OUT movement', () => {
    expect(fn).toContain("'EXCHANGE_OUT'")
  })

  test('it decrements physical stock through the canonical path', () => {
    expect(fn).toContain('SET stock_on_hand = stock_on_hand - v_item.quantity')
    // And never below reserved.
    expect(fn).toContain('stock_on_hand - v_item.quantity >= reserved_quantity')
  })

  test('it snapshots the ACTUAL resulting COGS', () => {
    expect(fn).toContain('SET line_cogs_cents = ')
    expect(fn).toContain('unit_cogs_cents_snapshot')
  })

  test('unknown cost stays NULL, never zero', () => {
    expect(fn).toContain("WHEN (v_fifo->>'total_cost_cents') IS NULL THEN NULL")
    expect(fn).toContain('CASE WHEN v_any_null THEN NULL ELSE v_cost END')
  })

  test('uncovered quantity is surfaced, not invented', () => {
    expect(fn).toContain("'uncovered_units'")
    expect(fn).toContain("'unknown_cost_units'")
  })

  test('a duplicate fulfilment cannot consume inventory twice', () => {
    expect(fn).toContain("v_exchange.status <> 'pending'")
    expect(fn).toContain("'already_shipped'")
  })

  test('it creates no order_items and therefore no revenue', () => {
    expect(fn).not.toContain('INSERT INTO order_items')
    expect(fn).not.toContain('INSERT INTO orders')
  })

  test('price-difference accounting is untouched here', () => {
    // Settlement stays entirely in the 018 payment/refund path.
    expect(fn).not.toContain('price_difference_cents')
    expect(fn).not.toContain('price_difference_status')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN SURFACE
// ═════════════════════════════════════════════════════════════════════════════

describe('inventory admin surface', () => {
  const readApi = (f: string) =>
    fs.readFileSync(path.join(__dirname, '../../app/api/admin/inventory/', f), 'utf8')
  const ui = fs.readFileSync(
    path.join(__dirname, '../../app/admin/financials/inventory/InventoryClient.tsx'), 'utf8')

  test('every inventory admin route requires admin auth', () => {
    for (const f of ['valuation/route.ts','write-offs/route.ts','purchases/route.ts']) {
      expect(readApi(f)).toContain('requireAdmin')
    }
  })

  test('write-off cost is derived server-side, never client-supplied', () => {
    const api = readApi('write-offs/route.ts')
    expect(api).toContain('record_inventory_write_off')
    // No cost field is read from the request body.
    expect(api).not.toContain('body.totalCostCents')
    expect(api).not.toContain('body.unitCost')
    // The write-off request sends variant, quantity, reason and notes only —
    // totalCostCents appears in the UI purely as a read-only display field.
    const submit = ui.slice(ui.indexOf('async function submitWriteOff'),
                            ui.indexOf('async function submitPurchase'))
    expect(submit).not.toContain('totalCostCents')
    expect(submit).not.toContain('unitCost')
    expect(submit).toContain('reason: woForm.reason')
  })

  test('valuation is derived from layers, not stored', () => {
    const api = readApi('valuation/route.ts')
    expect(api).toContain('inventory_valuation()')
    expect(api).toContain('reconcile_inventory_layers()')
  })

  test('a partial valuation is flagged and never shown as complete', () => {
    const api = readApi('valuation/route.ts')
    expect(api).toContain('isPartialValuation')
    expect(ui).toContain('Partial valuation')
    expect(ui).toContain('not a complete inventory valuation')
  })

  test('known and unknown cost units are reported separately', () => {
    expect(ui).toContain('knownCostUnits')
    expect(ui).toContain('unknownCostUnits')
  })

  test('reconciliation differences are surfaced', () => {
    expect(readApi('valuation/route.ts')).toContain('reconciliationFailures')
    expect(ui).toContain('does not match')
  })

  test('purchase payments require an explicit cash date', () => {
    const api = readApi('purchases/route.ts')
    expect(api).toContain('Paid date must be YYYY-MM-DD')
    expect(ui).toContain('Paid on (when money left)')
  })

  test('the UI states that payments are not COGS', () => {
    expect(ui).toContain('never operating expenses and never COGS')
  })

  test('all admin mutations write an audit log', () => {
    for (const f of ['write-offs/route.ts','purchases/route.ts']) {
      expect(readApi(f)).toContain('admin_audit_logs')
    }
  })

  test('Inventory Value appears in the admin navigation', () => {
    const nav = fs.readFileSync(
      path.join(__dirname, '../../components/admin/AdminShell.tsx'), 'utf8')
    expect(nav).toContain("href: '/admin/financials/inventory'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PARTIAL BATCH RECEIPT — cumulative allocation loses no cents
// ═════════════════════════════════════════════════════════════════════════════

/** The OLD method: remainder scaled independently on every call. */
function premiumIndependent(remainder: number, units: number, qty: number) {
  return Math.min(qty, Math.round((remainder * qty) / units))
}
/** The FIXED method: cumulative telescoping, mirroring receive_batch_units. */
function premiumCumulative(remainder: number, units: number, before: number, qty: number) {
  return Math.round((remainder * (before + qty)) / units)
       - Math.round((remainder * before) / units)
}

describe('partial receipts capitalise the same total as a single receipt', () => {

  test('1+1+1 of a 1c remainder over 3 units loses a cent under the old method', () => {
    // The exact regression: three separate receipts each round 0.333 to zero.
    let total = 0
    for (let i = 0; i < 3; i++) total += premiumIndependent(1, 3, 1)
    expect(total).toBe(0)          // cent lost
  })

  test('the cumulative method allocates the cent exactly once', () => {
    let before = 0, total = 0
    for (let i = 0; i < 3; i++) { total += premiumCumulative(1, 3, before, 1); before += 1 }
    expect(total).toBe(1)
  })

  test('every partition of $100 over 3 units capitalises 10000', () => {
    const base = Math.floor(10000 / 3), rem = 10000 - base * 3
    for (const partition of [[3], [1, 2], [2, 1], [1, 1, 1]]) {
      let before = 0, premium = 0, units = 0
      for (const q of partition) {
        premium += premiumCumulative(rem, 3, before, q)
        before += q; units += q
      }
      const value = (units - premium) * base + premium * (base + 1)
      expect(value).toBe(10000)
    }
  })

  test('exhaustive: single-unit receipts reconcile for every remainder', () => {
    for (let units = 1; units <= 12; units++) {
      for (let rem = 0; rem < units; rem++) {
        let before = 0, premium = 0
        for (let i = 0; i < units; i++) {
          premium += premiumCumulative(rem, units, before, 1); before += 1
        }
        expect(premium).toBe(rem)
      }
    }
  })

  test('mixed-size partitions also reconcile', () => {
    for (const partition of [[1, 3, 2], [4, 2], [2, 2, 2], [5, 1]]) {
      const units = partition.reduce((a, b) => a + b, 0)
      for (let rem = 0; rem < units; rem++) {
        let before = 0, premium = 0
        for (const q of partition) { premium += premiumCumulative(rem, units, before, q); before += q }
        expect(premium).toBe(rem)
      }
    }
  })

  test('a tiny remainder over many units still lands exactly once', () => {
    let before = 0, premium = 0
    for (let i = 0; i < 7; i++) { premium += premiumCumulative(1, 7, before, 1); before += 1 }
    expect(premium).toBe(1)
  })

  test('the SQL uses cumulative allocation, not per-call scaling', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    expect(fn).toContain('v_prem_this   := v_prem_after - v_prem_before')
    // The leaking formula must be gone.
    expect(ddl).not.toContain('ROUND(v_remainder * v_scale)')
    expect(ddl).not.toContain('v_scale')
  })

  test('receipt progress is recorded in an append-only ledger', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS inventory_batch_receipts')
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    expect(fn).toContain('FROM inventory_batch_receipts WHERE cost_batch_id = p_batch_id')
  })
})

describe('receipt guards', () => {
  const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))

  test('cumulative over-receipt is rejected', () => {
    expect(fn).toContain('KVRN_RECEIPT|OVER_RECEIPT')
    expect(fn).toContain('v_before + p_quantity > v_units')
  })

  test('a variant from another product is rejected', () => {
    expect(fn).toContain('KVRN_RECEIPT|PRODUCT_MISMATCH')
  })

  test('a variant-scoped batch rejects a different variant', () => {
    expect(fn).toContain('KVRN_RECEIPT|VARIANT_SCOPE_MISMATCH')
  })

  test('a colour-scoped batch rejects a different colour', () => {
    expect(fn).toContain('KVRN_RECEIPT|COLOUR_SCOPE_MISMATCH')
  })

  test('validation happens before any stock mutation', () => {
    // A rejected receipt must leave inventory untouched.
    const mismatchIdx = fn.indexOf('KVRN_RECEIPT|PRODUCT_MISMATCH')
    const stockIdx    = fn.indexOf('SET stock_on_hand = stock_on_hand + p_quantity')
    expect(mismatchIdx).toBeGreaterThan(0)
    expect(mismatchIdx).toBeLessThan(stockIdx)
  })

  test('a duplicate idempotency key adds no stock', () => {
    expect(fn).toContain("'duplicate_receipt'")
    expect(ddl).toContain('CONSTRAINT ibr_idempotency_uq UNIQUE (idempotency_key)')
    const dupIdx   = fn.indexOf("'duplicate_receipt'")
    const stockIdx = fn.indexOf('SET stock_on_hand = stock_on_hand + p_quantity')
    expect(dupIdx).toBeLessThan(stockIdx)
  })

  test('per-unit batches still receive without a remainder', () => {
    expect(fn).toContain("v_derived->>'outcome' = 'per_unit_mode'")
  })
})

describe('purchase reconciliation is a flag, not an enforced equality', () => {

  test('capitalised cost and cash paid are reported side by side', () => {
    expect(ddl).toContain('FUNCTION purchase_reconciliation')
    const start = ddl.indexOf('FUNCTION purchase_reconciliation')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('intended_capitalized_cents')
    expect(fn).toContain('received_capitalized_cents')
    expect(fn).toContain('cash_paid_cents')
    expect(fn).toContain('variance_cents')
  })

  test('a variance raises nothing — deposits legitimately lead receipts', () => {
    // Bounded to the function body; it is a read-only reporting view.
    const start = ddl.indexOf('FUNCTION purchase_reconciliation')
    const fn = ddl.slice(start, ddl.indexOf('\n$$;', start))
    expect(fn).not.toContain('RAISE EXCEPTION')
  })

  test('batch receipt status exposes progress and both cost figures', () => {
    expect(ddl).toContain('FUNCTION batch_receipt_status')
    const start = ddl.indexOf('FUNCTION batch_receipt_status')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('remaining_units')
    expect(fn).toContain('intended_capitalized_cents')
    expect(fn).toContain('received_capitalized_cents')
    expect(fn).toContain('fully_received')
  })
})

describe('receipt admin surface', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '../../app/api/admin/inventory/receipts/route.ts'), 'utf8')
  const ui = fs.readFileSync(
    path.join(__dirname, '../../app/admin/financials/inventory/InventoryClient.tsx'), 'utf8')

  test('the route requires admin auth and audits', () => {
    expect(api).toContain('requireAdmin')
    expect(api).toContain('admin_audit_logs')
  })

  test('cost is never accepted from the client', () => {
    expect(api).not.toContain('body.unitCost')
    expect(api).not.toContain('body.totalCents')
    const submit = ui.slice(ui.indexOf('async function submitReceipt'),
                            ui.indexOf('async function submitPurchase'))
    expect(submit).not.toContain('Cost')
    expect(submit).toContain('quantity:    Number(rcForm.quantity)')
  })

  test('guard failures map to plain operator messages', () => {
    for (const t of ['OVER_RECEIPT','PRODUCT_MISMATCH','VARIANT_SCOPE_MISMATCH','COLOUR_SCOPE_MISMATCH']) {
      expect(api).toContain(t)
    }
    expect(api).toContain('exceeds the units this batch was created for')
  })

  test('the UI explains that partial receipts capitalise identically', () => {
    expect(ui).toContain('cumulative')
    expect(ui).toContain('never rounded away')
  })

  test('a receipt carries an idempotency key', () => {
    expect(ui).toContain('idempotencyKey')
  })

  test('batch progress and purchase variance are shown', () => {
    expect(ui).toContain('Batch progress')
    expect(ui).toContain('Purchase reconciliation')
    expect(ui).toContain('review flag, not an error')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY IS FAIL-CLOSED
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors the receive_batch_units idempotency gate. */
type Receipt = { key: string; batch: string; variant: string; qty: number }
function idempotencyGate(
  existing: Receipt | undefined,
  req: { batch: string; variant: string; qty: number },
): 'proceed' | 'duplicate_receipt' | 'conflict' {
  if (!existing) return 'proceed'
  const same = existing.batch === req.batch
            && existing.variant === req.variant
            && existing.qty === req.qty
  return same ? 'duplicate_receipt' : 'conflict'
}

describe('a reused idempotency key fails closed', () => {
  const orig: Receipt = { key: 'abc', batch: 'A', variant: 'VA', qty: 10 }

  test('an identical retry is a genuine replay', () => {
    expect(idempotencyGate(orig, { batch: 'A', variant: 'VA', qty: 10 }))
      .toBe('duplicate_receipt')
  })

  test('the same key with a different quantity conflicts', () => {
    expect(idempotencyGate(orig, { batch: 'A', variant: 'VA', qty: 5 })).toBe('conflict')
  })

  test('the same key with a different variant conflicts', () => {
    expect(idempotencyGate(orig, { batch: 'A', variant: 'VB', qty: 10 })).toBe('conflict')
  })

  test('the same key with a different batch conflicts', () => {
    expect(idempotencyGate(orig, { batch: 'B', variant: 'VA', qty: 10 })).toBe('conflict')
  })

  test('every differing field is checked, not just one', () => {
    for (const req of [
      { batch: 'B', variant: 'VA', qty: 10 },
      { batch: 'A', variant: 'VB', qty: 10 },
      { batch: 'A', variant: 'VA', qty: 11 },
      { batch: 'B', variant: 'VB', qty: 11 },
    ]) expect(idempotencyGate(orig, req)).toBe('conflict')
  })

  test('an unused key proceeds normally', () => {
    expect(idempotencyGate(undefined, { batch: 'A', variant: 'VA', qty: 10 })).toBe('proceed')
  })

  test('the SQL compares all three fields, not the key alone', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    expect(fn).toContain('v_existing.cost_batch_id = p_batch_id')
    expect(fn).toContain('v_existing.variant_id = p_variant_id')
    expect(fn).toContain('v_existing.quantity   = p_quantity')
    expect(fn).toContain('KVRN_RECEIPT|IDEMPOTENCY_CONFLICT')
  })

  test('the conflict raises before ANY mutation', () => {
    // Order matters: a raise after the stock update would still roll back, but
    // checking first keeps the guarantee obvious and independent of transaction
    // semantics.
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    const conflictIdx = fn.indexOf('IDEMPOTENCY_CONFLICT')
    for (const mutation of [
      'SET stock_on_hand = stock_on_hand + p_quantity',
      'INSERT INTO inventory_movements',
      'add_inventory_layer(',
      'INSERT INTO inventory_batch_receipts',
    ]) {
      expect(conflictIdx).toBeLessThan(fn.indexOf(mutation))
    }
  })

  test('the check is race-safe via a transaction-scoped advisory lock', () => {
    const fn = ddl.slice(ddl.indexOf('FUNCTION receive_batch_units'))
    expect(fn).toContain('pg_advisory_xact_lock(hashtext(p_idempotency_key))')
    // Serialisation happens before the existence check.
    expect(fn.indexOf('pg_advisory_xact_lock'))
      .toBeLessThan(fn.indexOf('FROM inventory_batch_receipts WHERE idempotency_key'))
  })

  test('the UNIQUE constraint remains the final backstop', () => {
    expect(ddl).toContain('CONSTRAINT ibr_idempotency_uq UNIQUE (idempotency_key)')
  })

  test('the API maps a conflict to HTTP 409', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/inventory/receipts/route.ts'), 'utf8')
    expect(api).toContain('IDEMPOTENCY_CONFLICT')
    expect(api).toContain('status: 409')
    expect(api).toContain('Nothing was received')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REPORTING CAPITALISATION IS CENT-EXACT
// ═════════════════════════════════════════════════════════════════════════════

describe('reporting never uses floored per-unit multiplication as authority', () => {

  test('the floored formula demonstrably loses cents', () => {
    // Why the authoritative total must be stored rather than recomputed.
    expect(Math.floor(10000 / 3) * 3).toBe(9999)   // 1c short of 10000
    expect(Math.floor(1 / 3) * 3).toBe(0)          // the whole cent vanishes
  })

  test('the authoritative total is persisted on the batch', () => {
    expect(ddl).toContain('capitalized_total_cents INTEGER')
    expect(ddl).toContain('capitalized_total_cents = v_grand')
  })

  test('the stored total includes every capitalisable component', () => {
    const start = ddl.indexOf('FUNCTION derive_batch_unit_costs')
    const fn = ddl.slice(start, ddl.indexOf('\n$$;', start))
    // manufacturing + packaging per unit, plus every batch-level charge.
    expect(fn).toContain('v_grand := (COALESCE(b.manufacturing_cents,0) + COALESCE(b.packaging_cents,0)) * v_units')
    expect(fn).toContain('+ v_freight + v_duties + v_tariffs + v_import + v_other')
  })

  test('batch status reads the stored total, not the floored product', () => {
    const start = ddl.indexOf('FUNCTION batch_receipt_status')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('b.capitalized_total_cents::bigint')
    // The floored product survives ONLY as a per-unit-mode fallback inside COALESCE.
    expect(fn).toContain('COALESCE(\n           b.capitalized_total_cents::bigint,')
  })

  test('received capitalisation comes from authoritative FIFO layers', () => {
    const start = ddl.indexOf('FUNCTION batch_receipt_status')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('SUM(units_received * COALESCE(unit_landed_cost_cents,0))')
    expect(fn).toContain('FROM inventory_cost_layers')
  })

  test('purchase reconciliation aggregates exact batch values', () => {
    const start = ddl.indexOf('FUNCTION purchase_reconciliation')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    // Sums the already-exact per-batch figures rather than recomputing.
    expect(fn).toContain('SUM(s.intended_capitalized_cents)')
    expect(fn).toContain('SUM(s.received_capitalized_cents)')
    expect(fn).not.toContain('pcb.unit_cogs_cents')
  })

  test('intended and received are distinct fields, never conflated', () => {
    const start = ddl.indexOf('FUNCTION batch_receipt_status')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('intended_capitalized_cents BIGINT')
    expect(fn).toContain('received_capitalized_cents BIGINT')
  })

  test('only a fully received batch can be flagged reconciled', () => {
    // A partial batch legitimately shows less received than intended and must
    // not be surfaced as a variance.
    const start = ddl.indexOf('FUNCTION batch_receipt_status')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('capitalization_reconciled  BOOLEAN')
    expect(fn).toContain('COALESCE(r.qty,0) >= b.units_received\n           AND COALESCE(l.value_cents, 0) =')
  })

  test('variance compares cash against RECEIVED value, not ordered value', () => {
    const start = ddl.indexOf('FUNCTION purchase_reconciliation')
    const fn = ddl.slice(start, ddl.indexOf('$$;', start))
    expect(fn).toContain('COALESCE(b.received, 0)::bigint - COALESCE(pay.paid, 0)::bigint')
  })

  test('the API exposes both figures distinctly', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '../../app/api/admin/inventory/receipts/route.ts'), 'utf8')
    expect(api).toContain('intendedCapitalizedCents')
    expect(api).toContain('receivedCapitalizedCents')
    expect(api).toContain('capitalizationReconciled')
  })

  test('the UI labels what the variance actually compares', () => {
    const ui = fs.readFileSync(
      path.join(__dirname, '../../app/admin/financials/inventory/InventoryClient.tsx'), 'utf8')
    expect(ui).toContain('ACTUALLY RECEIVED')
    expect(ui).toContain('not all received')
    // A partial batch is not shown as a variance.
    expect(ui).toContain('const matches = b.capitalizationReconciled')
  })

  test('no TypeScript path multiplies a floored unit cost by quantity', () => {
    for (const f of ['../../app/api/admin/inventory/receipts/route.ts',
                     '../../app/admin/financials/inventory/InventoryClient.tsx']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
      expect(src).not.toContain('unitCogsCents *')
      expect(src).not.toContain('* unitCogsCents')
    }
  })
})
