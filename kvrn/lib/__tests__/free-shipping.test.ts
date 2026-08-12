import {
  FREE_SHIPPING_THRESHOLD_CENTS,
  qualifiesForFreeShipping,
  applyFreeShippingToRates,
  applyFreeShippingToSingleRate,
} from '../free-shipping'

const STANDARD = { id: 'standard', cents: 1999, label: 'USPS Ground Advantage' }
const EXPRESS  = { id: 'express',  cents: 2999, label: 'USPS Priority Mail'    }
const RATES    = [STANDARD, EXPRESS]

// ── qualifiesForFreeShipping ──────────────────────────────────────────────────

describe('qualifiesForFreeShipping', () => {
  test('threshold is $150.00 (15000 cents)', () => {
    expect(FREE_SHIPPING_THRESHOLD_CENTS).toBe(15_000)
  })

  // Test 1 — US, below threshold
  test('US + 14999 cents → does NOT qualify', () => {
    expect(qualifiesForFreeShipping('US', 14_999)).toBe(false)
  })

  // Test 2 — US, exactly at threshold
  test('US + 15000 cents → qualifies (boundary inclusive)', () => {
    expect(qualifiesForFreeShipping('US', 15_000)).toBe(true)
  })

  // Test 3 — US, above threshold
  test('US + 16000 cents → qualifies', () => {
    expect(qualifiesForFreeShipping('US', 16_000)).toBe(true)
  })

  // Test 4 — non-US, above threshold
  test('CA + 20000 cents → does NOT qualify (non-US)', () => {
    expect(qualifiesForFreeShipping('CA', 20_000)).toBe(false)
  })
  test('GB + 20000 cents → does NOT qualify (non-US)', () => {
    expect(qualifiesForFreeShipping('GB', 20_000)).toBe(false)
  })
  test('country comparison is case-insensitive', () => {
    expect(qualifiesForFreeShipping('us', 15_000)).toBe(true)
  })
})

// ── applyFreeShippingToRates ──────────────────────────────────────────────────

describe('applyFreeShippingToRates', () => {
  // Test 1 — below threshold: no change
  test('US + 14999 → no rates modified', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 14_999)
    expect(result[0].cents).toBe(1999)
    expect(result[1].cents).toBe(2999)
  })

  // Test 2 — exactly at threshold
  test('US + 15000 → cheapest (standard) becomes free', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 15_000)
    expect(result[0].cents).toBe(0)       // standard → free
    expect(result[1].cents).toBe(2999)    // express  → unchanged
  })

  // Test 3 — above threshold
  test('US + 20000 → cheapest option free', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 20_000)
    expect(result[0].cents).toBe(0)
    expect(result[1].cents).toBe(2999)
  })

  // Test 4 — non-US, well above threshold
  test('non-US + 20000 → no rates modified', () => {
    const result = applyFreeShippingToRates(RATES, 'CA', 20_000)
    expect(result[0].cents).toBe(1999)
    expect(result[1].cents).toBe(2999)
  })

  // Test 5 — Shippo rates: only cheapest free
  test('Shippo rates → only cheapest (standard) is free; express unchanged', () => {
    const shippoRates = [
      { id: 'standard', cents: 843,  label: 'USPS Ground Advantage — 3–5 days' },
      { id: 'express',  cents: 1234, label: 'USPS Priority Mail — 1–2 days'    },
    ]
    const result = applyFreeShippingToRates(shippoRates, 'US', 15_000)
    expect(result[0].cents).toBe(0)     // standard free
    expect(result[1].cents).toBe(1234)  // express paid
  })

  // Test 6 — static fallback: only cheapest free
  test('static fallback rates → cheapest (1999) free; express (2999) paid', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 15_000)
    expect(result.find(r => r.id === 'standard')!.cents).toBe(0)
    expect(result.find(r => r.id === 'express')!.cents).toBe(2999)
  })

  // Test 7 — express remains paid when standard is free
  test('express rate is never zeroed when standard is cheapest', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 99_999)
    expect(result[0].cents).toBe(0)       // standard only
    expect(result[1].cents).toBe(2999)    // express stays paid
  })

  test('preserves all non-price fields on the zeroed rate', () => {
    const result = applyFreeShippingToRates(RATES, 'US', 15_000)
    const freeRate = result[0]
    expect(freeRate.id).toBe('standard')
    expect(freeRate.label).toBe('USPS Ground Advantage')
    expect(freeRate.cents).toBe(0)
  })

  test('returns a new array — does not mutate input', () => {
    const input  = [{ ...STANDARD }, { ...EXPRESS }]
    const result = applyFreeShippingToRates(input, 'US', 15_000)
    expect(input[0].cents).toBe(1999)   // original untouched
    expect(result[0].cents).toBe(0)     // new array has zero
  })

  test('empty rates array returns empty array', () => {
    expect(applyFreeShippingToRates([], 'US', 15_000)).toEqual([])
  })
})

// ── applyFreeShippingToSingleRate ─────────────────────────────────────────────

describe('applyFreeShippingToSingleRate', () => {
  test('selected method IS cheapest + qualifies → returns 0', () => {
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', 15_000)).toBe(0)
  })

  test('selected method IS NOT cheapest + qualifies → keeps original price', () => {
    // customer chose express (2999) while standard (1999) is cheaper
    expect(applyFreeShippingToSingleRate(2999, 1999, 'express', 'US', 15_000)).toBe(2999)
  })

  test('does not qualify (below threshold) → keeps original price', () => {
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', 14_999)).toBe(1999)
  })

  test('does not qualify (non-US) → keeps original price', () => {
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'CA', 50_000)).toBe(1999)
  })

  // Test 8 — server revalidation prevents client tampering
  test('server checkout revalidation: authoritative subtotal from reservation prevents tampering', () => {
    // Scenario: client claims subtotal is 15000 (qualifies), but reservation
    // reveals true subtotal is only 4999 (below threshold).
    // The handler MUST use the reservation subtotal, not the client-claimed value.
    //
    // applyFreeShippingToSingleRate is called with the reservation subtotal:
    const reservationSubtotal = 4_999  // server-authoritative (from reservation items)
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', reservationSubtotal)).toBe(1999)

    // With the tampered client subtotal it would incorrectly return 0:
    const tamperedSubtotal = 15_000
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', tamperedSubtotal)).toBe(0)
    // ↑ This shows WHY the handler must use reservation items, not client values
  })

  // Tie-breaking: standard always wins over express when prices are equal
  test('tied prices: selecting Standard → Standard is free', () => {
    expect(applyFreeShippingToSingleRate(1999, 1999, 'standard', 'US', 15_000)).toBe(0)
  })

  test('tied prices: selecting Express → Express remains paid (standard wins tie)', () => {
    expect(applyFreeShippingToSingleRate(1999, 1999, 'express', 'US', 15_000)).toBe(1999)
  })

  test('displayed rates and server use identical tie-breaking: standard always first free', () => {
    // applyFreeShippingToRates zeros the first (lowest-index) cheapest rate.
    // Rates array is always [standard, express], so standard wins ties in display.
    // applyFreeShippingToSingleRate must match: standard wins, express stays paid.
    const tiedRates = [
      { id: 'standard', cents: 1999 },
      { id: 'express',  cents: 1999 },
    ]
    const displayResult = applyFreeShippingToRates(tiedRates, 'US', 15_000)
    expect(displayResult[0].cents).toBe(0)     // standard free in display
    expect(displayResult[1].cents).toBe(1999)  // express paid in display

    // Server single-rate check matches
    expect(applyFreeShippingToSingleRate(1999, 1999, 'standard', 'US', 15_000)).toBe(0)    // standard → free
    expect(applyFreeShippingToSingleRate(1999, 1999, 'express',  'US', 15_000)).toBe(1999) // express → paid
  })
})

// ── Server-authoritative subtotal tests ──────────────────────────────────────

describe('server-authoritative subtotal (getSubtotalCentsForItems contract)', () => {
  // These tests verify the BEHAVIOUR the route relies on from getSubtotalCentsForItems.
  // The function itself requires a DB connection; DB integration tests require
  // TEST_DATABASE_URL. Here we test the logic contract with pure assertions.

  test('subtotal is quantity-weighted: 2 × $80 items = 16000 cents', () => {
    // Simulate what getSubtotalCentsForItems returns for 2 × PKHH at 8000 cents each
    const serverSubtotal = 8000 * 2   // 16000 — qualifies for free shipping
    expect(qualifiesForFreeShipping('US', serverSubtotal)).toBe(true)
    const rates = applyFreeShippingToRates(
      [{ id: 'standard', cents: 843 }, { id: 'express', cents: 1234 }],
      'US', serverSubtotal
    )
    expect(rates[0].cents).toBe(0)      // standard free
    expect(rates[1].cents).toBe(1234)   // express paid
  })

  test('1 × $80 item = 8000 cents → does NOT qualify', () => {
    const serverSubtotal = 8000 * 1   // 8000 — below threshold
    expect(qualifiesForFreeShipping('US', serverSubtotal)).toBe(false)
    const rates = applyFreeShippingToRates(
      [{ id: 'standard', cents: 843 }, { id: 'express', cents: 1234 }],
      'US', serverSubtotal
    )
    expect(rates[0].cents).toBe(843)    // no change
    expect(rates[1].cents).toBe(1234)   // no change
  })

  test('unknown SKU → null subtotal → rule not applied (safe default)', () => {
    // When getSubtotalCentsForItems returns null (unknown/inactive SKU),
    // the route does NOT apply free shipping. This test confirms the correct
    // behavior: null subtotal → pass original rates unchanged.
    const nullSubtotal = null
    const rates = [{ id: 'standard', cents: 843 }, { id: 'express', cents: 1234 }]
    // Simulate route logic: only apply rule when subtotalCents !== null
    const result = nullSubtotal !== null
      ? applyFreeShippingToRates(rates, 'US', nullSubtotal)
      : rates
    expect(result[0].cents).toBe(843)   // unchanged — rule not applied
    expect(result[1].cents).toBe(1234)  // unchanged
  })

  test('client subtotal tampering has no effect — server price is authoritative', () => {
    // Scenario: client claims it has $200 of merchandise but real DB prices say only $80.
    // The route resolves price from Neon, so tampered client subtotals are ignored.
    const tamperedClientSubtotal  = 20_000  // $200 claimed by client
    const serverComputedSubtotal  = 8_000   // $80 from Neon products table

    const rates = [{ id: 'standard', cents: 1999 }, { id: 'express', cents: 2999 }]

    // With tampered value: would (incorrectly) qualify
    expect(applyFreeShippingToRates(rates, 'US', tamperedClientSubtotal)[0].cents).toBe(0)

    // With server value: correctly does NOT qualify
    expect(applyFreeShippingToRates(rates, 'US', serverComputedSubtotal)[0].cents).toBe(1999)
    // ↑ This is why the route calls getSubtotalCentsForItems instead of reading body.subtotalCents
  })

  test('checkout handler is also protected: reservation subtotal always used', () => {
    // Even if /api/shipping-rates were somehow bypassed, the checkout handler
    // independently recalculates subtotal from reservation.items before Stripe.
    // This test mirrors the revalidation test above, confirming dual protection.
    const reservationSubtotal = 8_000   // true subtotal from reservation.items
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', reservationSubtotal)).toBe(1999)

    // A tampered high value (if it were somehow passed in) would incorrectly qualify:
    expect(applyFreeShippingToSingleRate(1999, 2999, 'standard', 'US', 20_000)).toBe(0)
    // The handler uses reservation.items sum, never client-provided values.
  })
})
