'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { useCart } from '@/context/CartContext'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import { formatCheckoutPrice } from '@/lib/format-money'
import { calculateShipping, US_SHIPPING_OPTIONS, type ShippingMethod } from '@/lib/stripe'
import { cn } from '@/lib/utils'

type Step = 'contact' | 'shipping'

interface ContactData {
  email:     string
  smsOptIn:  boolean
  phone:     string
}

interface AddressData {
  firstName: string
  lastName:  string
  line1:     string
  line2:     string
  city:      string
  state:     string
  postalCode: string
}

// ─── Main checkout page ───────────────────────────────────────────────────────
export default function CheckoutPage() {
  const { items, subtotalPence } = useCart()

  const [isClient,       setIsClient]       = useState(false)
  const [step,           setStep]           = useState<Step>('contact')
  const [paymentError,   setPaymentError]   = useState('')
  const [creatingSession, setCreatingSession] = useState(false)

  const [contact, setContact] = useState<ContactData>({ email: '', smsOptIn: false, phone: '' })
  const [address, setAddress] = useState<AddressData>({
    firstName: '', lastName: '', line1: '', line2: '', city: '', state: '', postalCode: '',
  })
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod>('standard')
  const [contactErrors,  setContactErrors]  = useState<Record<string, string>>({})
  const [addressErrors,  setAddressErrors]  = useState<Record<string, string>>({})
  // Live Shippo rates — fetched when address zip+state are filled in
  const [liveRates,      setLiveRates]      = useState<Array<{
    id: string; label: string; cents: number; minDays: number; maxDays: number; default: boolean
  }> | null>(null)
  const [fetchingRates,  setFetchingRates]  = useState(false)

  useEffect(() => { setIsClient(true) }, [])

  // Fetch live Shippo rates when zip + state are entered (debounced 800ms)
  useEffect(() => {
    const zip   = address.postalCode.trim()
    const state = address.state.trim()
    const city  = address.city.trim()
    // Need at least zip + state to get rates
    if (!zip || zip.length < 5 || !state || state.length < 2) {
      setLiveRates(null)
      return
    }
    const timer = setTimeout(async () => {
      setFetchingRates(true)
      try {
        const res = await fetch('/api/shipping-rates', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            city, state, zip, country: 'US',
            items: items.map(i => ({ sku: i.sku, quantity: i.quantity })),
          }),
        })
        if (res.ok) {
          const data = await res.json()
          if (data?.data?.rates?.length) {
            setLiveRates(data.data.rates)
            // Keep current selection if it exists in new rates, else reset to default
            const ids = (data.data.rates as any[]).map((r: any) => r.id)
            if (!ids.includes(shippingMethod)) {
              const defaultRate = (data.data.rates as any[]).find((r: any) => r.default)
              if (defaultRate) setShippingMethod(defaultRate.id as ShippingMethod)
            }
          }
        }
      } catch {
        // Network error — keep static rates (no UI disruption)
      } finally {
        setFetchingRates(false)
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [address.postalCode, address.state, address.city, items])

  // Use live rate if available; fall back to static
  const currentShippingOpts = liveRates
    ? liveRates
    : Object.values(US_SHIPPING_OPTIONS).map(o => ({
        id: o.method, label: o.label, cents: o.cents,
        minDays: o.minDays, maxDays: o.maxDays, default: o.method === 'standard'
      }))

  const activeOpt     = currentShippingOpts.find(o => o.id === shippingMethod) ?? currentShippingOpts[0]
  const shippingCents = activeOpt?.cents ?? calculateShipping('US', shippingMethod)
  const totalCents    = subtotalPence + shippingCents

  // ── Validate contact ──────────────────────────────────────────────────────
  const validateContact = () => {
    const errs: Record<string, string> = {}
    if (!contact.email.trim()) errs.email = 'Email is required.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errs.email = 'Enter a valid email.'
    setContactErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ── Validate address ──────────────────────────────────────────────────────
  const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
  ])
  const validateAddress = () => {
    const errs: Record<string, string> = {}
    if (!address.firstName.trim()) errs.firstName = 'First name is required.'
    if (!address.lastName.trim())  errs.lastName  = 'Last name is required.'
    if (!address.line1.trim())     errs.line1     = 'Address is required.'
    if (!address.city.trim())      errs.city      = 'City is required.'
    const state = address.state.trim().toUpperCase()
    if (!state || !US_STATES.has(state)) errs.state = 'Enter a valid US state code (e.g. CA).'
    if (!/^\d{5}(-\d{4})?$/.test(address.postalCode.trim())) errs.postalCode = 'Enter a valid ZIP code.'
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
            state:      address.state.trim().toUpperCase(),
            postalCode: address.postalCode.trim(),
            country:    'US',
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        // For stock errors, build a customer-friendly message using cart display names
        if (data.code === 'OUT_OF_STOCK' || data.code === 'INSUFFICIENT_STOCK') {
          const cartItem = data.sku ? items.find(i => i.sku === data.sku) : null
          if (cartItem) {
            setPaymentError(
              `${cartItem.productName} — ${cartItem.colorName} / ${cartItem.size} is sold out.`
            )
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
  }, [items, contact, address, shippingMethod])

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

        {/* ── Left: Form ──────────────────────────────────────────────── */}
        <div style={{ flex:'1 1 400px', minWidth:0 }}>

          {/* Header */}
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

          {/* ── Contact ── */}
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
                    style={contact.email ? inputStyle : inputStyle}
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

          {/* ── Shipping ── */}
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
                {/* Country (locked to US) */}
                <div>
                  <label style={labelStyle}>Country</label>
                  <div style={{ ...inputStyle, background:'#F1EEE8', color:'#9B9B9B', display:'flex', alignItems:'center' }}>
                    United States
                  </div>
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
                    <label style={labelStyle}>State *</label>
                    <input value={address.state} autoComplete="address-level1"
                      onChange={e => setAddress(a => ({ ...a, state: e.target.value }))}
                      className="checkout-input" placeholder="CA" maxLength={2} />
                    {addressErrors.state && <p style={errStyle}>{addressErrors.state}</p>}
                  </div>
                  <div>
                    <label style={labelStyle}>ZIP code *</label>
                    <input value={address.postalCode} autoComplete="postal-code"
                      onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))}
                      className="checkout-input" placeholder="90210" />
                    {addressErrors.postalCode && <p style={errStyle}>{addressErrors.postalCode}</p>}
                  </div>
                </div>
              </div>

              {/* Shipping method */}
              <h2 style={{ fontSize:11, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase',
                           color:'#1A1A1A', marginTop:32, marginBottom:16 }}>
                Shipping method
              </h2>
              {fetchingRates && (
                <p style={{ fontSize:11, color:'#9B9B9B', marginBottom:8, letterSpacing:'0.04em' }}>
                  Calculating shipping rates…
                </p>
              )}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {currentShippingOpts.map(opt => (
                  <label key={opt.id}
                    style={{
                      display:'flex', alignItems:'center', justifyContent:'space-between',
                      padding:'14px 16px', border:`1.5px solid ${shippingMethod === opt.id ? '#1A1A1A' : '#E8E5E0'}`,
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
                    <span style={{ fontSize:13, fontWeight: opt.cents === 0 ? 500 : 400, color: opt.cents === 0 ? '#059669' : 'inherit' }}>{opt.cents === 0 ? 'FREE' : formatCheckoutPrice(opt.cents)}</span>
                  </label>
                ))}
              </div>

              {paymentError && (
                <div style={{ marginTop:16, padding:'12px 16px', background:'#FEF2F2',
                              border:'1px solid #FECACA', color:'#B91C1C', fontSize:13 }}>
                  {paymentError}
                </div>
              )}

              <Button variant="primary" size="lg" fullWidth loading={creatingSession}
                style={{ marginTop:28 }} onClick={handleCheckout}>
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

            {/* Items */}
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
                <span style={{ color: shippingCents === 0 ? '#059669' : 'inherit', fontWeight: shippingCents === 0 ? 500 : 400 }}>{shippingCents === 0 ? 'FREE' : formatCheckoutPrice(shippingCents)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, fontWeight:500,
                            borderTop:'1px solid #E8E5E0', paddingTop:12, marginTop:4 }}>
                <span>Total</span>
                <span>{formatCheckoutPrice(totalCents)}</span>
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
