'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useCart } from '@/context/CartContext'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import { formatCheckoutPrice } from '@/lib/format-money'
import { type ShippingMethod } from '@/lib/stripe'
import { qualifiesForFreeShipping, FREE_SHIPPING_THRESHOLD_CENTS } from '@/lib/free-shipping'
import { COUNTRIES } from '@/lib/countries'
import { cn } from '@/lib/utils'

type Step = 'contact' | 'shipping'

interface ContactData {
  email:    string
  smsOptIn: boolean
  phone:    string
}

interface AddressData {
  firstName:  string
  lastName:   string
  line1:      string
  line2:      string
  city:       string
  state:      string
  postalCode: string
  country:    string   // 2-letter ISO code
}

// ─── Main checkout page ───────────────────────────────────────────────────────
export default function CheckoutPage() {
  const { items, subtotalPence } = useCart()

  const [isClient,         setIsClient]         = useState(false)
  const [step,             setStep]             = useState<Step>('contact')
  const [paymentError,     setPaymentError]     = useState('')
  const [creatingSession,  setCreatingSession]  = useState(false)

  const [contact, setContact] = useState<ContactData>({ email: '', smsOptIn: false, phone: '' })
  const [address, setAddress] = useState<AddressData>({
    firstName: '', lastName: '', line1: '', line2: '',
    city: '', state: '', postalCode: '', country: 'US',
  })
  const [shippingMethod,   setShippingMethod]   = useState<ShippingMethod>('standard')
  const [discountInput,    setDiscountInput]    = useState('')
  const [smsOfferCode,     setSmsOfferCode]     = useState<string|null>(null)
  const [discountApplied,  setDiscountApplied]  = useState<{
    code: string; error: string | null; discountCents?: number;
    shippingAdjustmentCents?: number; displayAmount?: string; type?: string;
  }>({ code: '', error: null })
  const [discountLoading,  setDiscountLoading]  = useState(false)
  const [discountInputError, setDiscountInputError] = useState<string|null>(null)
  const [contactErrors,    setContactErrors]    = useState<Record<string, string>>({})
  const [addressErrors,    setAddressErrors]    = useState<Record<string, string>>({})

  // Live Shippo rates from /api/shipping-rates
  const [shippingUnavail,        setShippingUnavail]        = useState(false)
  const [liveRates,             setLiveRates]             = useState<Array<{
    id: string; label: string; cents: number; minDays: number; maxDays: number; default: boolean
  }> | null>(null)
  const [fetchingRates,         setFetchingRates]         = useState(false)
  const [internationalUnavail,  setInternationalUnavail]  = useState(false)

  useEffect(() => { setIsClient(true) }, [])

  const isUS = address.country === 'US'

  // Minimum destination data required before requesting live Shippo rates.
  const shippingAddressReady = isUS
    ? (
        address.postalCode.trim().length >= 5 &&
        address.state.trim().length >= 2 &&
        address.city.trim().length >= 1
      )
    : (
        address.postalCode.trim().length >= 2 &&
        address.city.trim().length >= 1
      )

  // Clear stale rates immediately when country changes
  useEffect(() => {
    setLiveRates(null)
    setInternationalUnavail(false)
    setShippingMethod('standard')
    // Also clear state/postal when switching country to avoid validation carryover
  }, [address.country])

  // Fetch live Shippo rates (debounced 800ms)
  useEffect(() => {
    const zip     = address.postalCode.trim()
    const state   = address.state.trim()
    const city    = address.city.trim()
    const country = address.country

    // Clear while waiting for fresh data
    setLiveRates(null)
    setInternationalUnavail(false)
    setShippingUnavail(false)

    // Gate: minimum address needed to get rates
    const countryIsUS = country === 'US'

    if (!shippingAddressReady || !items.length) return

    const timer = setTimeout(async () => {
      setFetchingRates(true)
      try {
        const res = await fetch('/api/shipping-rates', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            city, state, zip, country,
            items: items.map(i => ({ sku: i.sku, quantity: i.quantity })),
          }),
        })
        if (res.ok) {
          const data = await res.json()
          const rates = data?.data?.rates
          const unavailable = data?.data?.unavailable === true
          if (rates?.length) {
            setLiveRates(rates)
            setShippingUnavail(false)
            // Keep current method if available, else auto-select default
            const ids = (rates as any[]).map((r: any) => r.id)
            if (!ids.includes(shippingMethod)) {
              const def = (rates as any[]).find((r: any) => r.default)
              if (def) setShippingMethod(def.id as ShippingMethod)
            }
          } else if (unavailable) {
            // Shippo temporarily unavailable — tell customer, keep payment disabled
            setShippingUnavail(true)
          } else if (!countryIsUS) {
            setInternationalUnavail(true)
          }
        } else if (!countryIsUS) {
          setInternationalUnavail(true)
        } else {
          // Non-4xx server error for US — treat as temporarily unavailable
          setShippingUnavail(true)
        }
      } catch {
        if (!countryIsUS) setInternationalUnavail(true)
        else setShippingUnavail(true)
      } finally {
        setFetchingRates(false)
      }
    }, 800)

    return () => clearTimeout(timer)
  }, [address.postalCode, address.state, address.city, address.country, items, shippingAddressReady])

  // ── Computed shipping display ─────────────────────────────────────────────

  // Customer-facing shipping rates come from live Shippo only.
  const currentShippingOpts = liveRates ?? []

  const activeOpt     = currentShippingOpts.find(o => o.id === shippingMethod) ?? currentShippingOpts[0]
  const shippingCents = activeOpt?.cents ?? null
  const appliedDiscountCents = discountApplied.code ? (discountApplied.discountCents ?? 0) : 0
  const appliedShippingAdj   = discountApplied.code ? (discountApplied.shippingAdjustmentCents ?? 0) : 0
  const effectiveShipping    = shippingCents !== null ? Math.max(0, shippingCents - appliedShippingAdj) : null
  const totalCents    = subtotalPence + (effectiveShipping ?? 0) - appliedDiscountCents

  // Checkout proceeds only after Shippo returns a real selectable rate.
  const canProceed = liveRates !== null && liveRates.length > 0 && !shippingUnavail
  // Client-side eligibility check for DISPLAY only; server is authoritative
  const freeShippingEligible = qualifiesForFreeShipping(address.country || 'US', subtotalPence)

  // ── US state validation set ───────────────────────────────────────────────
  const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
  ])

  // ── Validate contact ──────────────────────────────────────────────────────
  const validateContact = () => {
    const errs: Record<string, string> = {}
    if (!contact.email.trim()) errs.email = 'Email is required.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errs.email = 'Enter a valid email.'
    setContactErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ── Validate address ──────────────────────────────────────────────────────
  const validateAddress = () => {
    const errs: Record<string, string> = {}
    if (!address.firstName.trim()) errs.firstName = 'First name is required.'
    if (!address.lastName.trim())  errs.lastName  = 'Last name is required.'
    if (!address.line1.trim())     errs.line1     = 'Address is required.'
    if (!address.city.trim())      errs.city      = 'City is required.'

    if (isUS) {
      const st = address.state.trim().toUpperCase()
      if (!st || !US_STATES.has(st)) errs.state = 'Enter a valid US state code (e.g. CA).'
      if (!/^\d{5}(-\d{4})?$/.test(address.postalCode.trim())) errs.postalCode = 'Enter a valid ZIP code.'
    } else {
      // International: postal required, state optional
      if (!address.postalCode.trim()) errs.postalCode = 'Postal code is required.'
    }

    if (!canProceed) {
      errs.shipping = 'Shipping rates are not available for this destination.'
    }

    setAddressErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleCheckout = useCallback(async () => {
    if (!validateAddress()) return

    const invalidItems = items.filter(i => !i.sku || !i.sku.startsWith('KVRN-'))
    if (invalidItems.length > 0) {
      setPaymentError('One or more items need to be reselected. Please return to the product page and choose your size.')
      return
    }

    setCreatingSession(true)
    setPaymentError('')

    try {
      const res = await fetch('/api/checkout/session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(discountApplied.code ? { discountCode: discountApplied.code } : {}),
          items:          items.map(i => ({ sku: i.sku, quantity: i.quantity })),
          email:          contact.email.trim(),
          phone:          contact.smsOptIn ? (contact.phone.trim() || undefined) : undefined,
          shippingMethod,
          shippingAddress: {
            firstName:  address.firstName.trim(),
            lastName:   address.lastName.trim(),
            line1:      address.line1.trim(),
            line2:      address.line2.trim() || undefined,
            city:       address.city.trim(),
            state:      address.state.trim().toUpperCase() || undefined,
            postalCode: address.postalCode.trim(),
            country:    address.country,    // actual country code — never hardcoded
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.code === 'OUT_OF_STOCK' || data.code === 'INSUFFICIENT_STOCK') {
          const cartItem = data.sku ? items.find(i => i.sku === data.sku) : null
          if (cartItem) {
            setPaymentError(`${cartItem.productName} — ${cartItem.colorName} / ${cartItem.size} is sold out.`)
          } else {
            setPaymentError('An item in your bag is sold out.')
          }
        } else {
          setPaymentError(data.error ?? 'Checkout unavailable. Please try again.')
        }
        return
      }
      if (!data.url) throw new Error('No checkout URL returned.')
      window.location.href = data.url
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setCreatingSession(false)
    }
  }, [items, contact, address, shippingMethod, canProceed])

  const handleApplyDiscount = async (overrideCode?: string) => {
    const code = (overrideCode ?? discountInput).trim().toUpperCase()
    if (!code) return
    setDiscountLoading(true)
    try {
      const cartItems = items.map((i: any) => ({ sku: i.sku ?? i.variantSku, quantity: i.quantity }))
      const res = await fetch('/api/discounts/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, country: address.country || 'US', items: cartItems, shippingMethod }),
      })
      const data = await res.json()
      if (!data.valid) {
        // Clear stale localStorage code on permanent server-authoritative invalidity
        const permanentReasons = new Set(['invalid','expired','already_redeemed'])
        const isPerm = res.status === 400 && (
          permanentReasons.has(data.reason) ||
          isPermanentDiscountError(data.error ?? '')
        )
        if (isPerm) {
          try { localStorage.removeItem('kvrn_sms_discount_code') } catch {}
          setSmsOfferCode(null)
        }
        // Do NOT clear an existing valid applied code just because a new one failed
        // Show error under the input; keep applied code in place
        const errorMsg = data.error ?? 'That code isn\'t valid.'
        setDiscountInputError(errorMsg)
      } else {
        setDiscountInputError(null)
        setDiscountApplied({ code: data.code, error: null,
          discountCents: data.discountCents, shippingAdjustmentCents: data.shippingAdjustmentCents,
          displayAmount: data.displayAmount, type: data.type })
      }
    } catch {
      setDiscountInputError('Network error. Please try again.')
    } finally {
      setDiscountLoading(false)
    }
  }

  const handleRemoveDiscount = () => {
    setDiscountApplied({ code: '', error: null })
    setDiscountInput('')
    setDiscountInputError(null)
  }

  // Permanent discount errors: clear stale localStorage code
  function isPermanentDiscountError(error: string): boolean {
    return [
      "That code isn't valid",
      'That code has already been used',
      'That code has expired',
      "isn't valid for your shipping",
    ].some(p => error.includes(p))
  }

  // Read stored SMS discount code + deeplink flag from localStorage
  useEffect(() => {
    try {
      const storedCode = localStorage.getItem('kvrn_sms_discount_code')
      if (storedCode && storedCode.startsWith('KVRN-')) setSmsOfferCode(storedCode)
      // Try to resolve a browser claim token (set by popup before Messages was opened)
      const claimRaw = localStorage.getItem('kvrn_sms_claim_token')
      if (claimRaw && !storedCode) {
        try {
          const claimData = JSON.parse(claimRaw)
          if (claimData.token && new Date(claimData.expiresAt) > new Date()) {
            fetch('/api/sms/claim/resolve', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: claimData.token }),
            })
              .then(r => r.json())
              .then(d => {
                if (d.success && d.discountCode) {
                  setSmsOfferCode(d.discountCode)
                  try { localStorage.setItem('kvrn_sms_discount_code', d.discountCode) } catch {}
                }
                // Remove claim token regardless (confirmed/consumed or expired)
                const permanent = ['confirmed','already_consumed','expired','invalid','no_offer']
                if (d.success || permanent.includes(d.reason)) {
                  try { localStorage.removeItem('kvrn_sms_claim_token') } catch {}
                }
              })
              .catch(() => {})  // retain token on network failure for retry
          } else {
            // Token expired client-side — clean up
            try { localStorage.removeItem('kvrn_sms_claim_token') } catch {}
          }
        } catch {}
      }
    } catch {}
  }, [])

  // Invalidate discount preview when shipping method changes (shipping discounts depend on cost)
  const prevMethodRef = useRef(shippingMethod)
  useEffect(() => {
    if (prevMethodRef.current !== shippingMethod && discountApplied.code) {
      // Revalidate: shipping discounts depend on the selected method's cost
      handleApplyDiscount()
    }
    prevMethodRef.current = shippingMethod
  }, [shippingMethod])

  // Invalidate discount preview when country or cart changes
  // (US $150 eligibility may change)
  const prevCountryRef = useRef(address.country)
  useEffect(() => {
    if (prevCountryRef.current !== address.country && discountApplied.code) {
      handleRemoveDiscount()
    }
    prevCountryRef.current = address.country
  }, [address.country])

  if (!isClient) return null

  if (items.length === 0) {
    return (
      <div style={{ minHeight:'100vh', paddingTop:'calc(36px + 56px + 80px)', background:'#F9F8F6' }}>
        <div style={{ maxWidth:480, margin:'0 auto', padding:'0 24px', textAlign:'center' }}>
          <p style={{ fontSize:15, color:'#6b7280' }}>Your cart is empty.</p>
        </div>
      </div>
    )
  }

  const stepLabels: Step[] = ['contact', 'shipping']

  return (
    <div style={{ minHeight:'100vh', background:'#F9F8F6', paddingTop:'calc(36px + 56px)' }}>
      <div style={{ maxWidth:1100, margin:'0 auto', padding:'40px 24px', display:'flex', gap:48, flexWrap:'wrap', alignItems:'start' }}>

        {/* ── Left: Form ──────────────────────────────────────────── */}
        <div style={{ flex:'1 1 400px', minWidth:0 }}>

          <h1 style={{ fontSize:22, fontWeight:400, letterSpacing:'0.06em', textTransform:'uppercase',
                       color:'#1A1A1A', marginBottom:32 }}>
            Checkout
          </h1>

          {/* Progress indicator */}
          <div style={{ display:'flex', gap:16, marginBottom:40 }}>
            {stepLabels.map((s, i) => (
              <div key={s} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{
                  width:20, height:20, borderRadius:'50%', fontSize:11, fontWeight:500,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  background: step === s || (i === 0 && step === 'shipping') ? '#1A1A1A' : '#E8E5E0',
                  color:      step === s || (i === 0 && step === 'shipping') ? '#fff' : '#9B9B9B',
                }}>
                  {i < stepLabels.indexOf(step) ? '✓' : i + 1}
                </div>
                <span style={{ fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase',
                               color: step === s ? '#1A1A1A' : '#9B9B9B' }}>
                  {s === 'contact' ? 'Contact' : 'Shipping'}
                </span>
                {i < stepLabels.length - 1 && (
                  <div style={{ width:32, height:1, background:'#E8E5E0', marginLeft:4 }} />
                )}
              </div>
            ))}
          </div>

          {/* ── Contact step ── */}
          {step === 'contact' && (
            <section>
              <h2 style={{ fontSize:11, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase',
                           color:'#1A1A1A', marginBottom:20 }}>
                Contact
              </h2>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div>
                  <label style={labelStyle}>Email *</label>
                  <input
                    type="email" autoComplete="email" value={contact.email}
                    onChange={e => setContact(c => ({ ...c, email: e.target.value }))}
                    className="checkout-input"
                    placeholder="you@example.com"
                  />
                  {contactErrors.email && <p style={errStyle}>{contactErrors.email}</p>}
                </div>
                <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
                  <input type="checkbox" checked={contact.smsOptIn}
                    onChange={e => setContact(c => ({ ...c, smsOptIn: e.target.checked, phone: e.target.checked ? c.phone : '' }))} />
                  <span style={{ fontSize:13, color:'#6b7280' }}>
                    Text me shipping updates (optional)
                  </span>
                </label>
                {contact.smsOptIn && (
                  <div>
                    <label style={labelStyle}>Phone</label>
                    <input
                      type="tel" autoComplete="tel" value={contact.phone}
                      onChange={e => setContact(c => ({ ...c, phone: e.target.value }))}
                      className="checkout-input" placeholder="+1 555 000 0000"
                    />
                  </div>
                )}
              </div>
              <Button variant="primary" size="lg" fullWidth
                style={{ marginTop:28 }}
                onClick={() => { if (validateContact()) setStep('shipping') }}>
                Continue to shipping
              </Button>
            </section>
          )}

          {/* ── Shipping step ── */}
          {step === 'shipping' && (
            <section>
              {/* Contact summary */}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                            padding:'12px 0', borderBottom:'1px solid #E8E5E0', marginBottom:24 }}>
                <span style={{ fontSize:13, color:'#6b7280' }}>{contact.email}</span>
                <button onClick={() => setStep('contact')}
                  style={{ fontSize:12, color:'#1A1A1A', background:'none', border:'none',
                           cursor:'pointer', letterSpacing:'0.06em', textDecoration:'underline' }}>
                  Edit
                </button>
              </div>

              <h2 style={{ fontSize:11, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase',
                           color:'#1A1A1A', marginBottom:20 }}>
                Shipping address
              </h2>

              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

                {/* Country selector */}
                <div>
                  <label style={labelStyle}>Country *</label>
                  <select
                    value={address.country}
                    onChange={e => setAddress(a => ({
                      ...a,
                      country:    e.target.value,
                      state:      '',   // clear on country change
                      postalCode: '',
                    }))}
                    style={{ ...inputStyle, cursor:'pointer' }}
                    autoComplete="country"
                  >
                    {COUNTRIES.map(c => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                  <div>
                    <label style={labelStyle}>First name *</label>
                    <input value={address.firstName} autoComplete="given-name"
                      onChange={e => setAddress(a => ({ ...a, firstName: e.target.value }))}
                      className="checkout-input" />
                    {addressErrors.firstName && <p style={errStyle}>{addressErrors.firstName}</p>}
                  </div>
                  <div>
                    <label style={labelStyle}>Last name *</label>
                    <input value={address.lastName} autoComplete="family-name"
                      onChange={e => setAddress(a => ({ ...a, lastName: e.target.value }))}
                      className="checkout-input" />
                    {addressErrors.lastName && <p style={errStyle}>{addressErrors.lastName}</p>}
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Address *</label>
                  <input value={address.line1} autoComplete="address-line1"
                    onChange={e => setAddress(a => ({ ...a, line1: e.target.value }))}
                    className="checkout-input" placeholder="123 Main St" />
                  {addressErrors.line1 && <p style={errStyle}>{addressErrors.line1}</p>}
                </div>

                <div>
                  <label style={labelStyle}>Apartment, suite, etc. (optional)</label>
                  <input value={address.line2} autoComplete="address-line2"
                    onChange={e => setAddress(a => ({ ...a, line2: e.target.value }))}
                    className="checkout-input" />
                </div>

                <div>
                  <label style={labelStyle}>City *</label>
                  <input value={address.city} autoComplete="address-level2"
                    onChange={e => setAddress(a => ({ ...a, city: e.target.value }))}
                    className="checkout-input" />
                  {addressErrors.city && <p style={errStyle}>{addressErrors.city}</p>}
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                  <div>
                    {/* Label and maxLength differ by country */}
                    <label style={labelStyle}>
                      {isUS ? 'State *' : 'State / Province / Region'}
                    </label>
                    <input
                      value={address.state}
                      autoComplete="address-level1"
                      onChange={e => setAddress(a => ({ ...a, state: e.target.value }))}
                      className="checkout-input"
                      placeholder={isUS ? 'CA' : ''}
                      maxLength={isUS ? 2 : 80}
                    />
                    {addressErrors.state && <p style={errStyle}>{addressErrors.state}</p>}
                  </div>
                  <div>
                    <label style={labelStyle}>
                      {isUS ? 'ZIP code *' : 'Postal code *'}
                    </label>
                    <input
                      value={address.postalCode}
                      autoComplete="postal-code"
                      onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))}
                      className="checkout-input"
                      placeholder={isUS ? '90210' : ''}
                    />
                    {addressErrors.postalCode && <p style={errStyle}>{addressErrors.postalCode}</p>}
                  </div>
                </div>
              </div>

              {/* ── Shipping method ── */}
              <h2 style={{ fontSize:11, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase',
                           color:'#1A1A1A', marginTop:32, marginBottom:16 }}>
                Shipping method
              </h2>

                {!shippingAddressReady && (
                  <div style={{
                    padding:'14px 16px',
                    background:'#F5F3EF',
                    border:'1px solid #E8E5E0',
                    color:'#7C7770',
                    fontSize:12,
                    lineHeight:1.5,
                    marginBottom:16,
                  }}>
                    Enter your shipping address to see available rates.
                  </div>
                )}

                {shippingAddressReady && fetchingRates && (
                  <p style={{
                    fontSize:11,
                    color:'#9B9B9B',
                    marginBottom:16,
                    letterSpacing:'0.04em'
                  }}>
                    Calculating shipping rates…
                  </p>
                )}

              {/* International: no live rates yet and we tried */}
              {!isUS && !fetchingRates && internationalUnavail && (
                <div style={{ padding:'12px 16px', background:'#FEF2F2',
                              border:'1px solid #FECACA', color:'#B91C1C', fontSize:13, marginBottom:16 }}>
                  Shipping is currently unavailable to this destination.
                </div>
              )}

              {/* US: Shippo temporarily unavailable — no fake rates shown */}
              {isUS && !fetchingRates && shippingUnavail && (
                <div style={{ padding:'12px 16px', background:'#FFF7ED',
                              border:'1px solid #FED7AA', color:'#92400E', fontSize:13, marginBottom:16 }}>
                  Shipping rates are temporarily unavailable. Please try again in a moment.
                </div>
              )}

              {currentShippingOpts.length > 0 && (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {currentShippingOpts.map(opt => (
                    <label key={opt.id}
                      style={{
                        display:'flex', alignItems:'center', justifyContent:'space-between',
                        padding:'14px 16px',
                        border:`1.5px solid ${shippingMethod === opt.id ? '#1A1A1A' : '#E8E5E0'}`,
                        cursor:'pointer', background:'#fff',
                      }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <input type="radio" name="shipping" value={opt.id}
                          checked={shippingMethod === opt.id}
                          onChange={() => setShippingMethod(opt.id as ShippingMethod)} />
                        <span>
                          <span style={{ fontSize:13, fontWeight:500 }}>{opt.label}</span>
                          {opt.minDays > 0 && (
                            <span style={{ fontSize:12, color:'#9B9B9B', marginLeft:8 }}>
                              {opt.minDays}–{opt.maxDays} business days
                            </span>
                          )}
                        </span>
                      </div>
                      <span style={{
                        fontSize:13,
                        fontWeight: opt.cents === 0 ? 500 : 400,
                        color: opt.cents === 0 ? '#059669' : 'inherit',
                      }}>
                        {opt.cents === 0 ? 'FREE' : formatCheckoutPrice(opt.cents)}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {paymentError && (
                <div style={{ marginTop:16, padding:'12px 16px', background:'#FEF2F2',
                              border:'1px solid #FECACA', color:'#B91C1C', fontSize:13 }}>
                  {paymentError}
                </div>
              )}
              {addressErrors.shipping && (
                <div style={{ marginTop:8, fontSize:11, color:'#B91C1C' }}>
                  {addressErrors.shipping}
                </div>
              )}

              <Button variant="primary" size="lg" fullWidth loading={creatingSession}
                disabled={!canProceed || creatingSession}
                style={{ marginTop:28, opacity: canProceed ? 1 : 0.5 }}
                onClick={handleCheckout}>
                Continue to secure payment
              </Button>

              <p style={{ marginTop:16, fontSize:11, color:'#9B9B9B', textAlign:'center',
                          letterSpacing:'0.04em' }}>
                You will be redirected to Stripe Hosted Checkout to enter payment details securely.
              </p>
            </section>
          )}
        </div>

        {/* ── Right: Order summary ─────────────────────────────────────── */}
        <div style={{ flex:'1 1 280px', maxWidth:380, width:'100%', margin:'0 auto' }}>
          <div style={{ background:'#fff', border:'1px solid #E8E5E0', padding:'24px' }}>
            <h2 style={{ fontSize:11, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase',
                         color:'#1A1A1A', marginBottom:20 }}>
              Order summary
            </h2>

            <div style={{ display:'flex', flexDirection:'column', gap:16, marginBottom:24 }}>
              {items.map(item => (
                <div key={item.cartItemId} style={{ display:'flex', gap:12, alignItems:'center' }}>
                  {item.image && (
                    <div style={{ width:56, height:56, flexShrink:0, background:'#F1EEE8', overflow:'hidden' }}>
                      <Image src={item.image} alt={item.productName} width={56} height={56}
                        style={{ objectFit:'cover', width:'100%', height:'100%' }} />
                    </div>
                  )}
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ fontSize:12, fontWeight:500, margin:0 }}>{item.productName}</p>
                    <p style={{ fontSize:11, color:'#9B9B9B', margin:'2px 0 0' }}>
                      {item.colorName} / {item.size}
                      {item.quantity > 1 && ` × ${item.quantity}`}
                    </p>
                  </div>
                  <span style={{ fontSize:13, fontWeight:500, flexShrink:0 }}>
                    {formatPrice(item.price * item.quantity)}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ borderTop:'1px solid #E8E5E0', paddingTop:16, display:'flex', flexDirection:'column', gap:10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
                <span style={{ color:'#6b7280' }}>Subtotal</span>
                <span>{formatPrice(subtotalPence)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
                <span style={{ color:'#6b7280' }}>Shipping</span>
                {shippingCents === null ? (
                  <span style={{ color:'#9B9B9B' }}>Calculated after address</span>
                ) : shippingCents === 0 ? (
                  <span style={{ color:'#059669', fontWeight:500 }}>FREE</span>
                ) : (
                  <span>{formatCheckoutPrice(shippingCents)}</span>
                )}
              </div>


              {/* ── AVAILABLE OFFERS ───────────────────────────────────── */}
              {(freeShippingEligible || (smsOfferCode && !discountApplied.code)) && (
                <div style={{ marginBottom:16 }}>
                  <p style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:9, letterSpacing:'0.12em',
                    textTransform:'uppercase', color:'#9B9B9B', marginBottom:10 }}>
                    Available Offers
                  </p>

                  {/* Free shipping — auto-detected, not a code */}
                  {freeShippingEligible && (
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                      padding:'10px 14px', background:'#F5FBF5', border:'1px solid #C8E6C8',
                      marginBottom:8 }}>
                      <div>
                        <p style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:11, fontWeight:500,
                          letterSpacing:'0.06em', textTransform:'uppercase', color:'#1A4A1A', margin:0 }}>
                          Free Shipping
                        </p>
                        <p style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:11, color:'#4A7A4A', margin:'2px 0 0' }}>
                          Orders ${(FREE_SHIPPING_THRESHOLD_CENTS / 100).toFixed(0)}+ · Applied automatically
                        </p>
                      </div>
                      <span style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:10, fontWeight:600, letterSpacing:'0.10em',
                        textTransform:'uppercase', color:'#1A4A1A' }}>APPLIED</span>
                    </div>
                  )}

                  {/* SMS signup discount — only surfaced if code exists, not yet applied */}
                  {smsOfferCode && !discountApplied.code && (
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                      padding:'10px 14px', background:'#F9F8F6', border:'1px solid #E8E5E0' }}>
                      <div>
                        <p style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:11, fontWeight:500,
                          letterSpacing:'0.06em', textTransform:'uppercase', color:'#1A1A1A', margin:0 }}>
                          SMS Welcome — $10 Off
                        </p>
                        <p style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:11, color:'#6B6B6B', margin:'2px 0 0' }}>
                          Your signup offer · {smsOfferCode}
                        </p>
                      </div>
                      <button
                        onClick={() => { setDiscountInput(smsOfferCode); void handleApplyDiscount(smsOfferCode) }}
                        disabled={discountLoading}
                        style={{ background:'#1A1A1A', color:'#fff', border:'none', cursor:'pointer',
                          fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif', fontSize:10, fontWeight:500, letterSpacing:'0.10em',
                          textTransform:'uppercase', padding:'7px 14px',
                          opacity: discountLoading ? 0.5 : 1 }}>
                        APPLY
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Discount Code & Summary ──────────────────────────────── */}
              {/* Input — shown when no code applied OR when a code is applied (for stacking attempts) */}
              {!discountApplied.code ? (
                <div>
                  <div style={{ display:'flex', gap:8 }}>
                    <input
                      type="text"
                      value={discountInput}
                      onChange={e => { setDiscountInput(e.target.value.toUpperCase()); setDiscountInputError(null) }}
                      onKeyDown={e => { if (e.key === 'Enter') handleApplyDiscount() }}
                      placeholder="DISCOUNT CODE"
                      style={{ flex:1, padding:'10px 12px', fontSize:12,
                               border: discountInputError ? '1px solid #FCA5A5' : '1px solid #E8E5E0',
                               background:'#fff', outline:'none', letterSpacing:'0.06em',
                               textTransform:'uppercase', fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif' }}
                      aria-invalid={!!discountInputError}
                      aria-describedby={discountInputError ? 'discount-error' : undefined}
                    />
                    <button
                      onClick={() => void handleApplyDiscount()}
                      disabled={discountLoading || !discountInput.trim()}
                      style={{ padding:'10px 14px', background:'#1A1A1A', color:'#fff', border:'none',
                               cursor:'pointer', fontSize:11, fontWeight:500, letterSpacing:'0.08em',
                               textTransform:'uppercase', opacity:(discountLoading || !discountInput.trim()) ? 0.4 : 1 }}
                      aria-busy={discountLoading}
                    >
                      {discountLoading ? '…' : 'APPLY'}
                    </button>
                  </div>
                  {discountInputError && (
                    <p id="discount-error" role="alert"
                      style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                               fontSize:11, color:'#B91C1C', marginTop:6, letterSpacing:'0.02em' }}>
                      {discountInputError}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  {/* Applied code banner */}
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                                background:'#F1EEE8', padding:'10px 12px', marginBottom: discountInputError ? 6 : 0 }}>
                    <div>
                      <span style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                                     fontSize:12, fontWeight:500, letterSpacing:'0.06em',
                                     textTransform:'uppercase', color:'#1A1A1A' }}>
                        {discountApplied.code}
                      </span>
                      {discountApplied.displayAmount && (
                        <span style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                                       fontSize:11, color:'#059669', marginLeft:8 }}>
                          {discountApplied.displayAmount}
                        </span>
                      )}
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <button
                        onClick={handleRemoveDiscount}
                        style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280',
                                 fontSize:11, letterSpacing:'0.04em', textDecoration:'underline',
                                 fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                                 display:'block' }}
                      >
                        REMOVE
                      </button>
                      <span style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                                     fontSize:10, color:'#9B9B9B', letterSpacing:'0.04em',
                                     display:'block', marginTop:2 }}>
                        One per order
                      </span>
                    </div>
                  </div>
                  {/* Stacking / second-code error shown when a code is already applied */}
                  {discountInputError && (
                    <p role="alert"
                      style={{ fontFamily:'-apple-system, Helvetica Neue, Arial, sans-serif',
                               fontSize:11, color:'#92400E', background:'#FFFBEB',
                               border:'1px solid #FDE68A', padding:'8px 12px',
                               letterSpacing:'0.02em' }}>
                      {discountInputError}
                    </p>
                  )}
                </div>
              )}

              {discountApplied.code && discountApplied.displayAmount && (
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'#059669' }}>
                  <span>Discount ({discountApplied.code})</span>
                  <span>{discountApplied.displayAmount}</span>
                </div>
              )}
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, fontWeight:500,
                            borderTop:'1px solid #E8E5E0', paddingTop:12, marginTop:4 }}>
                <span>Total</span>
                {shippingCents === null ? (
                  <span style={{ color:'#9B9B9B' }}>—</span>
                ) : (
                  <span>{formatCheckoutPrice(totalCents)}</span>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display:'block', fontSize:11, fontWeight:500, letterSpacing:'0.06em',
  textTransform:'uppercase', color:'#1A1A1A', marginBottom:6,
}

const inputStyle: React.CSSProperties = {
  width:'100%', padding:'10px 14px', fontSize:14, border:'1px solid #E8E5E0',
  background:'#fff', outline:'none', boxSizing:'border-box',
}

const errStyle: React.CSSProperties = {
  fontSize:11, color:'#B91C1C', marginTop:4,
}
