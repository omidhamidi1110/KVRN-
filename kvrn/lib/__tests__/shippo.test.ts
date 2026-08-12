// lib/__tests__/shippo.test.ts
// Tests for pickRatesForDestination — country-aware Shippo rate selection.
// No DB or real Shippo connection required.

import { pickRatesForDestination } from '../shippo'

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
