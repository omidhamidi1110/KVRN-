'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/context/CartContext'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import { calculateShipping } from '@/lib/stripe'
import { cn } from '@/lib/utils'

// ── Stripe Elements (uncomment once stripe packages installed) ──────────────
// import { loadStripe } from '@stripe/stripe-js'
// import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
// const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

type Step = 'contact' | 'shipping' | 'payment'

const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'IE', name: 'Ireland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
  { code: 'NO', name: 'Norway' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'BE', name: 'Belgium' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'AT', name: 'Austria' },
  { code: 'PL', name: 'Poland' },
]

interface ContactData {
  email:      string
  smsOptIn:   boolean
  phone:      string
}

interface AddressData {
  firstName: string
  lastName:  string
  address1:  string
  address2:  string
  city:      string
  postcode:  string
  country:   string
}

// ─── Inner payment form (will wrap with <Elements> when Stripe connected) ────
function PaymentForm({
  clientSecret,
  totalPence,
  onSuccess,
}: {
  clientSecret: string
  totalPence:   number
  onSuccess:    (paymentIntentId: string) => void
}) {
  const [paying, setPaying] = useState(false)
  const [error,  setError]  = useState('')

  // ── With Stripe Elements (uncomment once connected): ───────────────────────
  // const stripe   = useStripe()
  // const elements = useElements()
  //
  // const handlePay = async () => {
  //   if (!stripe || !elements) return
  //   setPaying(true)
  //   setError('')
  //
  //   const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
  //     elements,
  //     redirect: 'if_required',
  //   })
  //
  //   if (stripeError) {
  //     setError(stripeError.message ?? 'Payment failed. Please try again.')
  //     setPaying(false)
  //     return
  //   }
  //   if (paymentIntent?.status === 'succeeded') {
  //     onSuccess(paymentIntent.id)
  //   }
  // }
  //
  // return (
  //   <div className="space-y-4">
  //     <PaymentElement options={{ layout: 'tabs' }} />
  //     {error && <p className="text-[13px] text-kvrn-error">{error}</p>}
  //     <Button variant="primary" size="lg" fullWidth onClick={handlePay} loading={paying}>
  //       Pay {formatPrice(totalPence)}
  //     </Button>
  //   </div>
  // )

  // ── MVP placeholder (remove once Stripe connected): ───────────────────────
  return (
    <div className="space-y-4">
      <div className="border border-kvrn-border bg-kvrn-bg-raised p-5 space-y-3">
        <p className="label-11 text-kvrn-muted mb-4">Card details</p>

        <div>
          <label htmlFor="card-number" className="label-11 block mb-2">Card number</label>
          <input
            id="card-number"
            type="text"
            placeholder="1234 5678 9012 3456"
            className="input-base"
            maxLength={19}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="card-expiry" className="label-11 block mb-2">Expiry</label>
            <input
              id="card-expiry"
              type="text"
              placeholder="MM / YY"
              className="input-base"
              maxLength={7}
            />
          </div>
          <div>
            <label htmlFor="card-cvc" className="label-11 block mb-2">CVC</label>
            <input
              id="card-cvc"
              type="text"
              placeholder="123"
              className="input-base"
              maxLength={4}
            />
          </div>
        </div>

        <div>
          <label htmlFor="card-name" className="label-11 block mb-2">Name on card</label>
          <input
            id="card-name"
            type="text"
            placeholder="James Taylor"
            autoComplete="cc-name"
            className="input-base"
          />
        </div>
      </div>

      <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800 leading-relaxed">
        <strong className="font-medium">Dev mode:</strong> Stripe not yet connected.
        Add <code className="bg-amber-100 px-1">NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code> to activate real payments.
        This form is a UI placeholder only — no card details are transmitted.
      </div>

      {error && <p role="alert" className="text-[13px] text-kvrn-error">{error}</p>}

      <Button
        variant="primary"
        size="lg"
        fullWidth
        loading={paying}
        onClick={() => {
          setPaying(true)
          // Simulate success for UI testing
          setTimeout(() => onSuccess('pi_test_placeholder'), 1500)
        }}
      >
        Pay {formatPrice(totalPence)} — Demo
      </Button>
    </div>
  )
}

// ─── Main checkout page ───────────────────────────────────────────────────────
export default function CheckoutPage() {
  const router = useRouter()
  const { items, subtotalPence, clearCart } = useCart()

  const [isClient,      setIsClient]      = useState(false)
  const [step,          setStep]          = useState<Step>('contact')
  const [clientSecret,  setClientSecret]  = useState('')
  const [paymentError,  setPaymentError]  = useState('')
  const [creatingIntent,setCreatingIntent]= useState(false)

  const [contact, setContact] = useState<ContactData>({
    email: '', smsOptIn: false, phone: '',
  })
  const [address, setAddress] = useState<AddressData>({
    firstName: '', lastName:  '',
    address1:  '', address2:  '',
    city:      '', postcode:  '',
    country:   'GB',
  })
  const [shippingMethod, setShippingMethod] = useState<'standard' | 'express'>('standard')
  const [contactErrors, setContactErrors]   = useState<Partial<ContactData>>({})
  const [addressErrors, setAddressErrors]   = useState<Partial<AddressData>>({})

  useEffect(() => { setIsClient(true) }, [])

  const shippingCost = calculateShipping(address.country, shippingMethod)
  const totalPence   = subtotalPence + shippingCost
  const vatPence     = Math.round(totalPence * (1 - 1 / 1.2))

  // Create Stripe PaymentIntent when moving to payment step
  const createPaymentIntent = useCallback(async () => {
    setCreatingIntent(true)
    setPaymentError('')
    try {
      const res = await fetch('/api/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.map(i => ({
            productId: i.productId,
            sku:       `${i.productId}-${i.color}-${i.size.toLowerCase()}`,
            name:      i.productName,
            color:     i.colorName,
            size:      i.size,
            price:     i.price,
            quantity:  i.quantity,
          })),
          email:           contact.email,
          shippingAddress: address,
          shippingMethod,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to initialise checkout.')
      setClientSecret(data.clientSecret)
      setStep('payment')
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setCreatingIntent(false)
    }
  }, [items, contact.email, address, shippingMethod])

  const handlePaymentSuccess = useCallback((paymentIntentId: string) => {
    clearCart()
    router.push(`/order-confirmation?pi=${paymentIntentId}`)
  }, [clearCart, router])

  // ─── Contact validation ───────────────────────────────────────────────────
  const validateContact = () => {
    const errs: Partial<ContactData> = {}
    if (!contact.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      errs.email = 'A valid email is required.' as never
    }
    setContactErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ─── Address validation ───────────────────────────────────────────────────
  const validateAddress = () => {
    const errs: Partial<AddressData> = {}
    if (!address.firstName.trim()) errs.firstName = 'Required' as never
    if (!address.lastName.trim())  errs.lastName  = 'Required' as never
    if (!address.address1.trim())  errs.address1  = 'Required' as never
    if (!address.city.trim())      errs.city      = 'Required' as never
    if (!address.postcode.trim())  errs.postcode  = 'Required' as never
    setAddressErrors(errs)
    return Object.keys(errs).length === 0
  }

  if (!isClient) return null

  if (items.length === 0) {
    return (
      <div className="pt-[56px] min-h-screen flex items-center justify-center">
        <div className="text-center space-y-5">
          <p className="text-[15px] font-light">Your bag is empty.</p>
          <Link href="/shop">
            <Button variant="secondary" size="md">Browse products</Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="pt-[56px] min-h-screen bg-kvrn-bg">
      <div className="container-kvrn py-8 md:py-12">

        {/* ─── Header ─── */}
        <div className="flex items-center justify-between mb-8 md:mb-12">
          <Link href="/" className="text-[15px] font-display font-light tracking-wider uppercase">
            KVRN
          </Link>

          <nav aria-label="Checkout progress" className="hidden sm:flex items-center gap-2 text-[11px] tracking-widest">
            {(['contact', 'shipping', 'payment'] as Step[]).map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                {i > 0 && <span className="text-kvrn-border" aria-hidden="true">›</span>}
                <span className={cn(
                  'uppercase',
                  step === s ? 'text-kvrn-text' : 'text-kvrn-subtle'
                )}>
                  {s}
                </span>
              </span>
            ))}
          </nav>
        </div>

        {/* ─── Two-column layout ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10 lg:gap-16 items-start">

          {/* ════ LEFT: Form ════ */}
          <div className="space-y-8 min-w-0">

            {/* Express checkout */}
            <div>
              <p className="label-11 mb-4">Express checkout</p>
              <div className="grid grid-cols-2 gap-3">
                {[{ id: 'apple', label: ' Pay' }, { id: 'google', label: 'G Pay' }].map(opt => (
                  <button
                    key={opt.id}
                    disabled
                    title="Available once Stripe is connected"
                    className="h-12 border border-kvrn-border text-[13px] font-light text-kvrn-muted flex items-center justify-center gap-2 cursor-not-allowed opacity-50"
                    aria-label={`Pay with ${opt.label}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-4 mt-5">
                <div className="flex-1 h-px bg-kvrn-border" />
                <span className="label-11 text-kvrn-subtle">or continue below</span>
                <div className="flex-1 h-px bg-kvrn-border" />
              </div>
            </div>

            {/* ── STEP 1: Contact ── */}
            <section aria-labelledby="step-contact">
              <div className="flex items-center justify-between mb-5">
                <h2 id="step-contact" className="label-11">
                  {step !== 'contact'
                    ? <span className="flex items-center gap-2">
                        <CheckIcon /> Contact
                      </span>
                    : 'Contact'
                  }
                </h2>
                {step !== 'contact' && (
                  <button
                    onClick={() => setStep('contact')}
                    className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2"
                  >
                    Edit
                  </button>
                )}
              </div>

              {step === 'contact' ? (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="email" className="sr-only">Email address</label>
                    <input
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder="Email address"
                      value={contact.email}
                      onChange={e => { setContact(c => ({ ...c, email: e.target.value })); setContactErrors({}) }}
                      className={cn('input-base', contactErrors.email && 'error')}
                    />
                    {contactErrors.email && (
                      <p role="alert" className="text-[12px] text-kvrn-error mt-1">{String(contactErrors.email)}</p>
                    )}
                  </div>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contact.smsOptIn}
                      onChange={e => setContact(c => ({ ...c, smsOptIn: e.target.checked }))}
                      className="accent-kvrn-text w-4 h-4"
                    />
                    <span className="text-[13px] text-kvrn-muted font-light">
                      Text me shipping updates
                    </span>
                  </label>

                  {contact.smsOptIn && (
                    <div>
                      <label htmlFor="phone" className="sr-only">Phone number</label>
                      <input
                        id="phone"
                        type="tel"
                        autoComplete="tel"
                        placeholder="+44 7700 900000"
                        value={contact.phone}
                        onChange={e => setContact(c => ({ ...c, phone: e.target.value }))}
                        className="input-base"
                      />
                      <p className="text-[11px] text-kvrn-subtle mt-1.5">Reply STOP to unsubscribe.</p>
                    </div>
                  )}

                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => { if (validateContact()) setStep('shipping') }}
                  >
                    Continue to shipping
                  </Button>
                </div>
              ) : (
                <p className="text-[14px] text-kvrn-muted">{contact.email}</p>
              )}
            </section>

            <div className="rule" />

            {/* ── STEP 2: Shipping ── */}
            <section aria-labelledby="step-shipping">
              <div className="flex items-center justify-between mb-5">
                <h2 id="step-shipping" className="label-11">
                  {step === 'payment'
                    ? <span className="flex items-center gap-2"><CheckIcon /> Shipping</span>
                    : 'Shipping address'
                  }
                </h2>
                {step === 'payment' && (
                  <button
                    onClick={() => setStep('shipping')}
                    className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2"
                  >
                    Edit
                  </button>
                )}
              </div>

              {step === 'shipping' ? (
                <div className="space-y-4">
                  {/* Name row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="firstName" className="sr-only">First name</label>
                      <input
                        id="firstName" type="text" autoComplete="given-name" placeholder="First name"
                        value={address.firstName}
                        onChange={e => { setAddress(a => ({ ...a, firstName: e.target.value })); setAddressErrors(v => ({ ...v, firstName: undefined })) }}
                        className={cn('input-base', addressErrors.firstName && 'error')}
                      />
                      {addressErrors.firstName && <p role="alert" className="text-[12px] text-kvrn-error mt-1">Required</p>}
                    </div>
                    <div>
                      <label htmlFor="lastName" className="sr-only">Last name</label>
                      <input
                        id="lastName" type="text" autoComplete="family-name" placeholder="Last name"
                        value={address.lastName}
                        onChange={e => { setAddress(a => ({ ...a, lastName: e.target.value })); setAddressErrors(v => ({ ...v, lastName: undefined })) }}
                        className={cn('input-base', addressErrors.lastName && 'error')}
                      />
                    </div>
                  </div>

                  {/* Address */}
                  <div>
                    <label htmlFor="address1" className="sr-only">Address</label>
                    <input
                      id="address1" type="text" autoComplete="address-line1" placeholder="Address"
                      value={address.address1}
                      onChange={e => { setAddress(a => ({ ...a, address1: e.target.value })); setAddressErrors(v => ({ ...v, address1: undefined })) }}
                      className={cn('input-base', addressErrors.address1 && 'error')}
                    />
                    {addressErrors.address1 && <p role="alert" className="text-[12px] text-kvrn-error mt-1">Required</p>}
                  </div>

                  <div>
                    <label htmlFor="address2" className="sr-only">Apartment, suite, etc. (optional)</label>
                    <input
                      id="address2" type="text" autoComplete="address-line2" placeholder="Apartment, suite, etc. (optional)"
                      value={address.address2}
                      onChange={e => setAddress(a => ({ ...a, address2: e.target.value }))}
                      className="input-base"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="city" className="sr-only">City</label>
                      <input
                        id="city" type="text" autoComplete="address-level2" placeholder="City"
                        value={address.city}
                        onChange={e => { setAddress(a => ({ ...a, city: e.target.value })); setAddressErrors(v => ({ ...v, city: undefined })) }}
                        className={cn('input-base', addressErrors.city && 'error')}
                      />
                    </div>
                    <div>
                      <label htmlFor="postcode" className="sr-only">Postcode</label>
                      <input
                        id="postcode" type="text" autoComplete="postal-code" placeholder="Postcode"
                        value={address.postcode}
                        onChange={e => { setAddress(a => ({ ...a, postcode: e.target.value })); setAddressErrors(v => ({ ...v, postcode: undefined })) }}
                        className={cn('input-base', addressErrors.postcode && 'error')}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="country" className="sr-only">Country</label>
                    <select
                      id="country"
                      autoComplete="country"
                      value={address.country}
                      onChange={e => setAddress(a => ({ ...a, country: e.target.value }))}
                      className="input-base appearance-none cursor-pointer"
                    >
                      {COUNTRIES.map(c => (
                        <option key={c.code} value={c.code}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Shipping method */}
                  <div className="pt-2" role="radiogroup" aria-labelledby="shipping-method-label">
                    <p id="shipping-method-label" className="label-11 mb-3">Shipping method</p>
                    <div className="space-y-2">
                      {([
                        {
                          id:    'standard' as const,
                          label: address.country === 'GB' ? 'Standard — 3–5 days' : 'Standard — 7–14 days',
                          cost:  calculateShipping(address.country, 'standard'),
                        },
                        {
                          id:    'express' as const,
                          label: address.country === 'GB' ? 'Express — 1–2 days' : 'Express — 3–7 days',
                          cost:  calculateShipping(address.country, 'express'),
                        },
                      ]).map(opt => (
                        <label
                          key={opt.id}
                          className={cn(
                            'flex items-center justify-between border p-4 cursor-pointer transition-colors duration-150',
                            shippingMethod === opt.id ? 'border-kvrn-text' : 'border-kvrn-border hover:border-kvrn-border-strong'
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              name="shipping"
                              value={opt.id}
                              checked={shippingMethod === opt.id}
                              onChange={() => setShippingMethod(opt.id)}
                              className="accent-kvrn-text"
                            />
                            <span className="text-[13px] font-light">{opt.label}</span>
                          </div>
                          <span className="text-[13px] font-light">{formatPrice(opt.cost)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {paymentError && (
                    <p role="alert" className="text-[13px] text-kvrn-error">{paymentError}</p>
                  )}

                  <Button
                    variant="primary"
                    size="md"
                    loading={creatingIntent}
                    onClick={() => { if (validateAddress()) createPaymentIntent() }}
                  >
                    Continue to payment
                  </Button>
                </div>
              ) : step === 'payment' ? (
                <div className="text-[13px] text-kvrn-muted space-y-0.5">
                  <p>{address.firstName} {address.lastName}</p>
                  <p>{address.address1}{address.address2 && `, ${address.address2}`}</p>
                  <p>{address.city}, {address.postcode}</p>
                  <p>{COUNTRIES.find(c => c.code === address.country)?.name}</p>
                  <p className="mt-1 text-kvrn-text">
                    {shippingMethod === 'standard' ? 'Standard' : 'Express'} shipping — {formatPrice(shippingCost)}
                  </p>
                </div>
              ) : null}
            </section>

            <div className="rule" />

            {/* ── STEP 3: Payment ── */}
            {step === 'payment' && (
              <section aria-labelledby="step-payment">
                <h2 id="step-payment" className="label-11 mb-5">Payment</h2>

                {/* When Stripe is connected, wrap PaymentForm in <Elements stripe={stripePromise} options={{ clientSecret }}> */}
                {clientSecret ? (
                  <PaymentForm
                    clientSecret={clientSecret}
                    totalPence={totalPence}
                    onSuccess={handlePaymentSuccess}
                  />
                ) : (
                  <PaymentForm
                    clientSecret=""
                    totalPence={totalPence}
                    onSuccess={handlePaymentSuccess}
                  />
                )}

                <div className="flex items-center gap-2 mt-4 text-[12px] text-kvrn-muted">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <rect x="1" y="4" width="12" height="9" rx="1" stroke="currentColor" strokeWidth="1"/>
                    <path d="M4 4V3a3 3 0 016 0v1" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  </svg>
                  <span>Secured by Stripe. Card details never stored by KVRN.</span>
                </div>
              </section>
            )}
          </div>

          {/* ════ RIGHT: Order summary ════ */}
          <aside
            className="border border-kvrn-border p-6 bg-kvrn-bg-raised space-y-5 lg:sticky lg:top-[72px]"
            aria-label="Order summary"
          >
            <h2 className="label-11">Order summary</h2>

            <ul className="space-y-4 divide-y divide-kvrn-border" aria-label="Items">
              {items.map(item => (
                <li key={item.cartItemId} className="flex items-start gap-4 pt-4 first:pt-0">
                  <div className="relative w-16 h-[85px] flex-shrink-0 bg-kvrn-bg overflow-hidden">
                    {item.image ? (
                      <Image src={item.image} alt={item.productName} fill sizes="64px" className="object-cover" />
                    ) : (
                      <div className="absolute inset-0" style={{ backgroundColor: item.colorHex + '30' }} />
                    )}
                    {/* Quantity badge */}
                    {item.quantity > 1 && (
                      <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-kvrn-text text-kvrn-bg text-[10px] flex items-center justify-center">
                        {item.quantity}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-light leading-snug">{item.productName}</p>
                    <p className="text-[12px] text-kvrn-muted mt-0.5">
                      {item.colorName} / {item.size}
                    </p>
                  </div>
                  <p className="text-[13px] font-light flex-shrink-0">
                    {formatPrice(item.price * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>

            <div className="rule" />

            <div className="space-y-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-kvrn-muted">Subtotal</span>
                <span className="font-light">{formatPrice(subtotalPence)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-kvrn-muted">Shipping</span>
                <span className="font-light">
                  {step === 'contact' ? '—' : formatPrice(shippingCost)}
                </span>
              </div>
            </div>

            <div className="rule" />

            <div className="flex justify-between text-[15px]">
              <span className="font-light">Total</span>
              <div className="text-right">
                <span className="font-light">
                  {step === 'contact' ? formatPrice(subtotalPence) : formatPrice(totalPence)}
                </span>
                {step !== 'contact' && (
                  <p className="text-[11px] text-kvrn-muted mt-0.5">
                    incl. VAT {formatPrice(vatPence)}
                  </p>
                )}
              </div>
            </div>

            <ul className="space-y-1.5 text-[12px] text-kvrn-muted pt-1 border-t border-kvrn-border">
              <li>Free returns within 30 days</li>
              <li>Tracked delivery on every order</li>
              <li>
                <Link href="/support/shipping-returns" className="underline underline-offset-2 hover:text-kvrn-text transition-colors">
                  Shipping & returns policy
                </Link>
              </li>
            </ul>
          </aside>
        </div>
      </div>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
