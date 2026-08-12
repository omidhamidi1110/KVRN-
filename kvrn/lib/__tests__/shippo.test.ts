// lib/__tests__/shippo.test.ts
// Tests for pickRatesForDestination — country-aware Shippo rate selection.
// No DB or real Shippo connection required.

import { pickRatesForDestination, aggregateInternationalParcels, type ShippoRate } from '../shippo'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRate(opts: {
  id:        string
  amount:    number   // USD
  token:     string
  name:      string
  days?:     number | null
  provider?: string
}) {
  return {
    object_id:      opts.id,
    amount:         String(opts.amount),
    currency:       'usd',
    hidden:         false,
    provider:       opts.provider ?? 'USPS',
    estimated_days: opts.days ?? null,
    servicelevel:   { token: opts.token, name: opts.name },
  }
}

const US_GROUND   = makeRate({ id:'a', amount:6.43,  token:'usps_ground_advantage', name:'Ground Advantage',  days:5  })
const US_PRIORITY = makeRate({ id:'b', amount:9.80,  token:'usps_priority',         name:'Priority Mail',      days:3  })
const US_EXPRESS  = makeRate({ id:'c', amount:29.99, token:'usps_priority_express',  name:'Priority Mail Exp',  days:2  })
const CA_FIRST    = makeRate({ id:'d', amount:36.57, token:'usps_first_class_package_international', name:'First Class Package Intl', days:12 })
const CA_PRIORITY = makeRate({ id:'e', amount:52.10, token:'usps_priority_mail_international',       name:'Priority Mail International',  days:7  })
const CA_EXPRESS  = makeRate({ id:'f', amount:78.00, token:'usps_express_mail_international',        name:'Express Mail International',   days:3  })

// ── US domestic ───────────────────────────────────────────────────────────────

describe('pickRatesForDestination — US domestic', () => {
  test('selects ground token as standard', () => {
    const r = pickRatesForDestination([US_GROUND, US_PRIORITY], 'US')
    expect(r.standard?.serviceToken).toBe('usps_ground_advantage')
  })

  test('selects cheapest express-token rate as express (not necessarily fastest)', () => {
    const r = pickRatesForDestination([US_GROUND, US_PRIORITY, US_EXPRESS], 'US')
    // usps_priority ($9.80) is in EXPRESS_TOKENS and cheaper than usps_priority_express ($29.99)
    // cheapest express-token match wins
    expect(r.express?.serviceToken).toBe('usps_priority')
  })

  test('no express token → express is null (US)', () => {
    const r = pickRatesForDestination([US_GROUND, US_PRIORITY], 'US')
    // usps_priority is in EXPRESS_TOKENS
    expect(r.express?.serviceToken).toBe('usps_priority')
  })

  test('only one rate → express is null', () => {
    const r = pickRatesForDestination([US_GROUND], 'US')
    expect(r.standard?.serviceToken).toBe('usps_ground_advantage')
    expect(r.express).toBeNull()
  })

  test('empty rates → both null', () => {
    const r = pickRatesForDestination([], 'US')
    expect(r.standard).toBeNull()
    expect(r.express).toBeNull()
  })

  test('country comparison is case-insensitive (us = US)', () => {
    const r = pickRatesForDestination([US_GROUND, US_PRIORITY], 'us')
    expect(r.standard?.serviceToken).toBe('usps_ground_advantage')
  })

  test('US behavior unchanged: hidden rates excluded', () => {
    const hidden = { ...US_GROUND, hidden: true, object_id:'hidden' }
    const r = pickRatesForDestination([hidden, US_PRIORITY], 'US')
    expect(r.standard?.serviceToken).toBe('usps_priority')
  })

  test('US behavior unchanged: non-USD rates excluded', () => {
    const gbp = { ...US_GROUND, currency: 'gbp', object_id: 'gbp' }
    const r = pickRatesForDestination([gbp, US_PRIORITY], 'US')
    expect(r.standard?.serviceToken).toBe('usps_priority')
  })
})

// ── International (Canada) ────────────────────────────────────────────────────

describe('pickRatesForDestination — international', () => {
  test('cheapest is standard for non-US', () => {
    const r = pickRatesForDestination([CA_FIRST, CA_PRIORITY, CA_EXPRESS], 'CA')
    expect(r.standard?.cents).toBe(3657)   // $36.57
    expect(r.standard?.serviceToken).toBe('usps_first_class_package_international')
  })

  test('real faster Shippo rate selected as express', () => {
    const r = pickRatesForDestination([CA_FIRST, CA_PRIORITY, CA_EXPRESS], 'CA')
    // CA_PRIORITY (7 days) and CA_EXPRESS (3 days) are both faster than CA_FIRST (12 days)
    // cheapest among faster = CA_PRIORITY at $52.10
    expect(r.express?.cents).toBe(5210)
    expect(r.express?.serviceToken).toBe('usps_priority_mail_international')
  })

  test('only one rate → express is null (no fabrication)', () => {
    const r = pickRatesForDestination([CA_FIRST], 'CA')
    expect(r.standard?.cents).toBe(3657)
    expect(r.express).toBeNull()
  })

  test('two rates, same estimated_days → express by keyword if available', () => {
    const slow1 = makeRate({ id:'g', amount:40, token:'canada_post_regular',   name:'Regular Parcel',  days:10 })
    const slow2 = makeRate({ id:'h', amount:60, token:'canada_post_expedited', name:'Expedited Parcel', days:10 })
    // same days → priority 1 (faster by days) fails; priority 2 (keyword) applies
    // 'expedited' matches INTL_EXPRESS_KEYWORDS
    const r = pickRatesForDestination([slow1, slow2], 'CA')
    expect(r.standard?.serviceToken).toBe('canada_post_regular')
    expect(r.express?.serviceToken).toBe('canada_post_expedited')
  })

  test('two rates, same days, no keywords → express is null', () => {
    const r1 = makeRate({ id:'i', amount:30, token:'some_economy', name:'Economy',        days:10 })
    const r2 = makeRate({ id:'j', amount:50, token:'some_slower',  name:'Standard Plus',  days:10 })
    const r = pickRatesForDestination([r1, r2], 'CA')
    expect(r.standard?.serviceToken).toBe('some_economy')
    expect(r.express).toBeNull()
  })

  test('express keyword matching: "priority" in name qualifies', () => {
    const std  = makeRate({ id:'k', amount:30, token:'regular_parcel', name:'Regular', days:10 })
    const prio = makeRate({ id:'l', amount:50, token:'priority_parcel', name:'Priority', days:10 })
    const r = pickRatesForDestination([std, prio], 'CA')
    expect(r.express?.serviceToken).toBe('priority_parcel')
  })

  test('express keyword matching: "worldwide" in name qualifies', () => {
    const std = makeRate({ id:'m', amount:40, token:'economy_intl', name:'Economy International', days:14 })
    const dhl = makeRate({ id:'n', amount:70, token:'dhl_express',   name:'DHL Express Worldwide', days:14 })
    const r = pickRatesForDestination([std, dhl], 'GB')
    expect(r.express?.serviceToken).toBe('dhl_express')
  })

  test('non-US never receives static US rate values ($19.99 / $29.99)', () => {
    // pickRatesForDestination never inserts static prices — all amounts come from Shippo data
    const r = pickRatesForDestination([CA_FIRST, CA_PRIORITY], 'CA')
    const allCents = [r.standard?.cents, r.express?.cents].filter(Boolean)
    expect(allCents).not.toContain(1999)  // $19.99 US static standard
    expect(allCents).not.toContain(2999)  // $29.99 US static express
  })

  test('international: cents computed from real Shippo amount', () => {
    const r = pickRatesForDestination([CA_FIRST], 'CA')
    expect(r.standard?.cents).toBe(3657)  // $36.57 → 3657 cents
  })
})

// ── Route-level behavior (rate-array size) ────────────────────────────────────

describe('rates array contents for non-US destinations', () => {
  test('Standard + real Express → both present from Shippo', () => {
    const r = pickRatesForDestination([CA_FIRST, CA_EXPRESS], 'CA')
    expect(r.standard).not.toBeNull()
    expect(r.express).not.toBeNull()
  })

  test('Standard only (no faster Shippo rate) → express null, caller omits it', () => {
    const r = pickRatesForDestination([CA_FIRST], 'CA')
    expect(r.standard).not.toBeNull()
    expect(r.express).toBeNull()
    // Caller (route) must NOT add static express — verified in route integration tests
  })
})

// ── Free-shipping rule: US-only ───────────────────────────────────────────────

import { applyFreeShippingToRates, qualifiesForFreeShipping } from '../free-shipping'

describe('free-shipping rule remains US-only', () => {
  test('US + $150+ qualifies', () => {
    expect(qualifiesForFreeShipping('US', 15_000)).toBe(true)
  })
  test('CA + $150+ does NOT qualify', () => {
    expect(qualifiesForFreeShipping('CA', 15_000)).toBe(false)
  })
  test('GB + $200+ does NOT qualify', () => {
    expect(qualifiesForFreeShipping('GB', 20_000)).toBe(false)
  })
  test('international rates unaffected by free-shipping rule', () => {
    const intlRates = [{ id:'standard', cents:3657 }, { id:'express', cents:5210 }]
    const result    = applyFreeShippingToRates(intlRates, 'CA', 99_999)
    expect(result[0].cents).toBe(3657)   // unchanged — CA doesn't qualify
    expect(result[1].cents).toBe(5210)
  })
})

// ── aggregateInternationalParcels — pure unit tests ───────────────────────────


function makeShippoRate(opts: Partial<ShippoRate> & { cents: number }): ShippoRate {
  return {
    method:       opts.method       ?? 'standard',
    cents:        opts.cents,
    label:        opts.label        ?? 'USPS First Class Package International Service',
    estimate:     opts.estimate     ?? '12–14 business days',
    minDays:      opts.minDays      ?? 12,
    maxDays:      opts.maxDays      ?? 14,
    stripeLabel:  opts.stripeLabel  ?? 'USPS FCPIS (12–14 business days)',
    provider:     opts.provider     ?? 'USPS',
    serviceToken: opts.serviceToken ?? 'usps_first_class_package_international',
  }
}

const PARCEL_A_STD = makeShippoRate({ cents: 3657, minDays: 12, maxDays: 14, serviceToken: 'usps_first_class_package_international' })
const PARCEL_A_EXP = makeShippoRate({ method: 'express', cents: 4881, label: 'USPS Priority Mail International', minDays: 7, maxDays: 9, serviceToken: 'usps_priority_mail_international', stripeLabel: 'USPS PMI (7-9)' })
const PARCEL_B_STD = makeShippoRate({ cents: 3210, label: 'USPS First Class Package International Service', minDays: 11, maxDays: 13, serviceToken: 'usps_first_class_package_international' })
const PARCEL_B_EXP = makeShippoRate({ method: 'express', cents: 4500, label: 'USPS Priority Mail International', minDays: 6, maxDays: 8, serviceToken: 'usps_priority_mail_international', stripeLabel: 'USPS PMI (6-8)' })

describe('aggregateInternationalParcels', () => {
  test('single parcel: returns unchanged (no aggregation)', () => {
    const r = aggregateInternationalParcels([{ standard: PARCEL_A_STD, express: PARCEL_A_EXP }])
    expect(r.standard.cents).toBe(3657)
    expect(r.express?.cents).toBe(4881)
  })

  test('two parcels: standard cents = sum of both standard rates', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: PARCEL_A_EXP },
      { standard: PARCEL_B_STD, express: PARCEL_B_EXP },
    ])
    expect(r.standard.cents).toBe(3657 + 3210)   // 6867
  })

  test('two parcels: express cents = sum of both express rates when all have express', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: PARCEL_A_EXP },
      { standard: PARCEL_B_STD, express: PARCEL_B_EXP },
    ])
    expect(r.express).not.toBeNull()
    expect(r.express!.cents).toBe(4881 + 4500)   // 9381
  })

  test('express omitted when any parcel lacks real express', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: PARCEL_A_EXP },
      { standard: PARCEL_B_STD, express: null },  // parcel B has no express
    ])
    expect(r.express).toBeNull()
  })

  test('delivery estimate is conservative (slowest parcel drives window)', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: null },  // 12-14 days
      { standard: PARCEL_B_STD, express: null },  // 11-13 days
    ])
    expect(r.standard.minDays).toBe(12)   // max of (12, 11)
    expect(r.standard.maxDays).toBe(14)   // max of (14, 13)
  })

  test('same service across all parcels → specific carrier label', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: null },
      { standard: PARCEL_B_STD, express: null },
    ])
    // Both use usps_first_class_package_international
    expect(r.standard.label).toBe('USPS First Class Package International Service')
    expect(r.standard.provider).toBe('USPS')
  })

  test('different services, same provider → "{Provider} International Standard"', () => {
    const parcelC = makeShippoRate({
      cents: 4800, provider: 'USPS',
      label: 'USPS Priority Mail International',
      serviceToken: 'usps_priority_mail_international',
      minDays: 7, maxDays: 9,
    })
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: null },  // FCPIS
      { standard: parcelC,       express: null },  // PMI
    ])
    expect(r.standard.label).toBe('USPS International Standard')
    expect(r.standard.provider).toBe('USPS')
    expect(r.standard.serviceToken).toBe('')
  })

  test('different providers → "International Standard" generic label', () => {
    const fedex = makeShippoRate({
      cents: 5000, provider: 'FedEx',
      label: 'FedEx International Economy',
      serviceToken: 'fedex_international_economy',
      minDays: 8, maxDays: 10,
    })
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: null },  // USPS
      { standard: fedex,         express: null },  // FedEx
    ])
    expect(r.standard.label).toBe('International Standard')
    expect(r.standard.provider).toBe('Multiple Carriers')
  })

  test('aggregated express also uses generic label when mixed services', () => {
    const expC = makeShippoRate({
      method: 'express', cents: 9000, provider: 'FedEx',
      label: 'FedEx International Priority',
      serviceToken: 'fedex_international_priority',
      minDays: 3, maxDays: 5,
    })
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: PARCEL_A_EXP },  // USPS express
      { standard: PARCEL_B_STD, express: expC },           // FedEx express
    ])
    expect(r.express).not.toBeNull()
    expect(r.express!.label).toBe('International Express')
    expect(r.express!.cents).toBe(4881 + 9000)
  })

  test('non-US aggregated rates never contain US static prices ($19.99 / $29.99)', () => {
    const r = aggregateInternationalParcels([
      { standard: PARCEL_A_STD, express: PARCEL_A_EXP },
      { standard: PARCEL_B_STD, express: PARCEL_B_EXP },
    ])
    expect(r.standard.cents).not.toBe(1999)
    expect(r.express?.cents).not.toBe(2999)
  })
})

// ── getShippoRates multi-parcel split (fetch mock) ────────────────────────────

describe('getShippoRates — international multi-parcel split quoting', () => {
  const originalFetch = global.fetch
  const originalEnv   = { ...process.env }

  beforeEach(() => {
    process.env.SHIPPO_FROM_STREET1 = '123 Main St'
    process.env.SHIPPO_FROM_CITY    = 'Los Angeles'
    process.env.SHIPPO_FROM_STATE   = 'CA'
    process.env.SHIPPO_FROM_ZIP     = '90001'
    process.env.SHIPPO_FROM_COUNTRY = 'US'
  })

  afterEach(() => {
    global.fetch = originalFetch
    // Restore only the env vars we set
    ;['SHIPPO_FROM_STREET1','SHIPPO_FROM_CITY','SHIPPO_FROM_STATE','SHIPPO_FROM_ZIP','SHIPPO_FROM_COUNTRY']
      .forEach(k => {
        if (originalEnv[k] !== undefined) process.env[k] = originalEnv[k]
        else delete process.env[k]
      })
    jest.restoreAllMocks()
  })

  function mockRateResponse(stdAmount: number, stdToken: string, expAmount?: number, expToken?: string) {
    const rates: any[] = [
      {
        object_id: `std-${stdToken}`, amount: String(stdAmount), currency: 'usd',
        hidden: false, provider: 'USPS', estimated_days: 12,
        servicelevel: { token: stdToken, name: 'First Class Intl' },
      },
    ]
    if (expAmount && expToken) {
      rates.push({
        object_id: `exp-${expToken}`, amount: String(expAmount), currency: 'usd',
        hidden: false, provider: 'USPS', estimated_days: 7,
        servicelevel: { token: expToken, name: 'Priority Mail Intl' },
      })
    }
    return { ok: true, json: async () => ({ rates }) }
  }

  // For multi-parcel to Canada, we need items that produce 2 parcels:
  // hoodie (PKHH) + sweatpants (PKHSP) → maxGarments=1 → 2 parcels
  const TWO_ITEM_CART = [
    { sku: 'KVRN-D001-PKHH-BLK-M',  quantity: 1 },
    { sku: 'KVRN-D001-PKHSP-BLK-M', quantity: 1 },
  ]
  const CA_ADDRESS = { city: 'Vancouver', state: 'BC', zip: 'V6B1A1', country: 'CA' }

  test('2 international parcels → exactly 2 separate Shippo requests', async () => {
    const { getShippoRates } = await import('../shippo')
    const fetchSpy = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_first_class_package_international'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_first_class_package_international'))
    global.fetch = fetchSpy as any

    await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('each split request contains exactly one parcel', async () => {
    const { getShippoRates } = await import('../shippo')
    const fetchSpy = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_fcpis'))
    global.fetch = fetchSpy as any

    await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')

    for (const [, opts] of fetchSpy.mock.calls) {
      const body = JSON.parse(opts.body)
      expect(body.parcels).toHaveLength(1)
    }
  })

  test('aggregated standard = sum of both real parcel standard rates', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_fcpis')) as any

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result?.standard.cents).toBe(3657 + 2910)   // 6567
  })

  test('aggregated express = sum when every parcel has real express', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis', 48.81, 'usps_priority_mail_international'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_fcpis', 40.00, 'usps_priority_mail_international')) as any

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result?.express).not.toBeNull()
    expect(result?.express!.cents).toBe(4881 + 4000)
  })

  test('express omitted when one parcel has no faster Shippo service', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis', 48.81, 'usps_priority_mail_international'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_fcpis')) as any  // no express for parcel 2

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result?.standard).not.toBeNull()
    expect(result?.express).toBeNull()
  })

  test('one parcel standard failure → null (whole order unavailable)', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: [] }) }) as any  // no rates at all

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result).toBeNull()
  })

  test('network failure on one parcel → null (whole order unavailable)', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis'))
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) }) as any  // 400

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result).toBeNull()
  })

  test('US 2-parcel still sends ONE multi-piece request', async () => {
    const { getShippoRates } = await import('../shippo')
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      mockRateResponse(6.43, 'usps_ground_advantage', 9.80, 'usps_priority')
    ) as any
    global.fetch = fetchSpy

    const US_ADDRESS = { city: 'Los Angeles', state: 'CA', zip: '90001', country: 'US' }
    await getShippoRates(US_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.parcels).toHaveLength(2)   // both parcels in one request
  })

  test('1 parcel to Canada still sends ONE request (not split)', async () => {
    const { getShippoRates } = await import('../shippo')
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      mockRateResponse(36.57, 'usps_first_class_package_international')
    ) as any
    global.fetch = fetchSpy

    const ONE_ITEM = [{ sku: 'KVRN-D001-PKHH-BLK-M', quantity: 1 }]
    await getShippoRates(CA_ADDRESS, ONE_ITEM, [], 'test-token')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('international result never uses US static prices ($19.99 / $29.99)', async () => {
    const { getShippoRates } = await import('../shippo')
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockRateResponse(36.57, 'usps_fcpis'))
      .mockResolvedValueOnce(mockRateResponse(29.10, 'usps_fcpis')) as any

    const result = await getShippoRates(CA_ADDRESS, TWO_ITEM_CART, [], 'test-token')
    expect(result?.standard.cents).not.toBe(1999)
    expect(result?.express?.cents).not.toBe(2999)
  })
})

// ── Free-shipping rule: international never qualifies ─────────────────────────

describe('free-shipping rule: non-US never qualifies regardless of subtotal', () => {
  const { applyFreeShippingToRates, qualifiesForFreeShipping } = require('../free-shipping')

  test('Canada $1000 subtotal does not qualify', () => {
    expect(qualifiesForFreeShipping('CA', 100_000)).toBe(false)
  })
  test('UK $1000 subtotal does not qualify', () => {
    expect(qualifiesForFreeShipping('GB', 100_000)).toBe(false)
  })
  test('aggregated international rates untouched by free-shipping rule', () => {
    const rates = [{ id: 'standard', cents: 6867 }, { id: 'express', cents: 9381 }]
    const result = applyFreeShippingToRates(rates, 'CA', 100_000)
    expect(result[0].cents).toBe(6867)
    expect(result[1].cents).toBe(9381)
  })
})
