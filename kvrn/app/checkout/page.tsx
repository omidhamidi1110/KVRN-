'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useCart } from '@/context/CartContext'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import Image from 'next/image'

// ─── Stripe Elements will be imported here in production ─────────────────────
// import { loadStripe } from '@stripe/stripe-js'
// import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
// const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

type CheckoutStep = 'contact' | 'shipping' | 'payment'

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
]

export default function CheckoutPage() {
  const { items, subtotalPence, clearCart } = useCart()
  const [step, setStep]         = useState<CheckoutStep>('contact')
  const [isClient, setIsClient] = useState(false)

  useEffect(() => setIsClient(true), [])

  // Fields
  const [email,    setEmail]    = useState('')
  const [smsOptin, setSmsOptin] = useState(false)
  const [phone,    setPhone]    = useState('')
  const [addr,     setAddr]     = useState({
    firstName: '', lastName: '',
    address1: '', address2: '',
    city: '', postcode: '', country: 'GB',
  })
  const [shipping, setShipping] = useState<'standard' | 'express'>('standard')

  if (!isClient) return null

  if (items.length === 0) {
    return (
      <div className="pt-[56px] min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-[15px] font-light">Your bag is empty.</p>
          <Link href="/shop">
            <Button variant="secondary" size="md">Browse products</Button>
          </Link>
        </div>
      </div>
    )
  }

  const shippingCost = addr.country === 'GB'
    ? (shipping === 'express' ? 999 : 499)
    : (addr.country === 'US' || addr.country === 'CA' ? 1999 : 1499)

  const totalPence = subtotalPence + shippingCost
  const vatPence   = Math.round(totalPence * (1 - 1 / 1.2))  // 20% VAT included

  return (
    <div className="pt-[56px] min-h-screen bg-kvrn-bg">
      <div className="container-kvrn py-8 md:py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 md:mb-12">
          <Link href="/" className="text-[15px] font-display font-light tracking-wider uppercase">
            KVRN
          </Link>
          <nav aria-label="Checkout steps" className="flex items-center gap-4 text-[11px] tracking-widest uppercase">
            {(['contact', 'shipping', 'payment'] as CheckoutStep[]).map((s, i) => (
              <span key={s} className="flex items-center gap-4">
                <span className={step === s ? 'text-kvrn-text' : 'text-kvrn-muted'}>{s}</span>
                {i < 2 && <span className="text-kvrn-border" aria-hidden="true">›</span>}
              </span>
            ))}
          </nav>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-8 lg:gap-16 items-start">
          {/* ─── Left: Form ─── */}
          <div className="space-y-8">

            {/* ─── Express checkout ─── */}
            <div>
              <p className="label-11 mb-4">Express checkout</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  className="h-12 border border-kvrn-border text-[13px] font-light hover:border-kvrn-border-strong transition-colors duration-150 flex items-center justify-center gap-2"
                  aria-label="Pay with Apple Pay"
                  onClick={() => alert('Apple Pay: Connect Stripe Payment Request Button')}
                >
                   Pay
                </button>
                <button
                  className="h-12 border border-kvrn-border text-[13px] font-light hover:border-kvrn-border-strong transition-colors duration-150 flex items-center justify-center gap-2"
                  aria-label="Pay with Google Pay"
                  onClick={() => alert('Google Pay: Connect Stripe Payment Request Button')}
                >
                  G Pay
                </button>
              </div>
              <div className="flex items-center gap-4 mt-4">
                <div className="flex-1 h-px bg-kvrn-border" />
                <span className="label-11 text-kvrn-subtle">or continue below</span>
                <div className="flex-1 h-px bg-kvrn-border" />
              </div>
            </div>

            {/* ─── Contact ─── */}
            <section aria-labelledby="contact-heading">
              <div className="flex items-center justify-between mb-4">
                <h2 id="contact-heading" className="label-11">Contact</h2>
                {step !== 'contact' && (
                  <button onClick={() => setStep('contact')} className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
                    Edit
                  </button>
                )}
              </div>

              {step === 'contact' ? (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="checkout-email" className="sr-only">Email address</label>
                    <input
                      id="checkout-email"
                      type="email"
                      autoComplete="email"
                      placeholder="Email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="input-base"
                    />
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={smsOptin}
                      onChange={(e) => setSmsOptin(e.target.checked)}
                      className="w-4 h-4 accent-kvrn-text"
                    />
                    <span className="text-[13px] text-kvrn-muted font-light">
                      Notify me by SMS when my order ships
                    </span>
                  </label>
                  {smsOptin && (
                    <input
                      type="tel"
                      autoComplete="tel"
                      placeholder="Phone number"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="input-base"
                    />
                  )}
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => { if (email) setStep('shipping') }}
                    disabled={!email}
                  >
                    Continue to shipping
                  </Button>
                </div>
              ) : (
                <p className="text-[14px] text-kvrn-muted">{email}</p>
              )}
            </section>

            <div className="rule" />

            {/* ─── Shipping Address ─── */}
            <section aria-labelledby="shipping-address-heading">
              <div className="flex items-center justify-between mb-4">
                <h2 id="shipping-address-heading" className="label-11">Shipping address</h2>
                {step === 'payment' && (
                  <button onClick={() => setStep('shipping')} className="text-[11px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
                    Edit
                  </button>
                )}
              </div>

              {step === 'shipping' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="firstName" className="sr-only">First name</label>
                      <input id="firstName" type="text" autoComplete="given-name" placeholder="First name"
                        value={addr.firstName} onChange={(e) => setAddr(a => ({ ...a, firstName: e.target.value }))}
                        className="input-base" />
                    </div>
                    <div>
                      <label htmlFor="lastName" className="sr-only">Last name</label>
                      <input id="lastName" type="text" autoComplete="family-name" placeholder="Last name"
                        value={addr.lastName} onChange={(e) => setAddr(a => ({ ...a, lastName: e.target.value }))}
                        className="input-base" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="address1" className="sr-only">Address</label>
                    <input id="address1" type="text" autoComplete="address-line1" placeholder="Address"
                      value={addr.address1} onChange={(e) => setAddr(a => ({ ...a, address1: e.target.value }))}
                      className="input-base" />
                  </div>
                  <div>
                    <label htmlFor="address2" className="sr-only">Apartment, suite, etc. (optional)</label>
                    <input id="address2" type="text" autoComplete="address-line2" placeholder="Apartment, suite, etc. (optional)"
                      value={addr.address2} onChange={(e) => setAddr(a => ({ ...a, address2: e.target.value }))}
                      className="input-base" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="city" className="sr-only">City</label>
                      <input id="city" type="text" autoComplete="address-level2" placeholder="City"
                        value={addr.city} onChange={(e) => setAddr(a => ({ ...a, city: e.target.value }))}
                        className="input-base" />
                    </div>
                    <div>
                      <label htmlFor="postcode" className="sr-only">Postcode</label>
                      <input id="postcode" type="text" autoComplete="postal-code" placeholder="Postcode"
                        value={addr.postcode} onChange={(e) => setAddr(a => ({ ...a, postcode: e.target.value }))}
                        className="input-base" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="country" className="sr-only">Country</label>
                    <select id="country" autoComplete="country"
                      value={addr.country} onChange={(e) => setAddr(a => ({ ...a, country: e.target.value }))}
                      className="input-base appearance-none cursor-pointer">
                      {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                  </div>

                  {/* Shipping method */}
                  <div className="pt-2 space-y-2" role="radiogroup" aria-labelledby="shipping-method-label">
                    <p id="shipping-method-label" className="label-11 mb-3">Shipping method</p>
                    {[
                      {
                        id: 'standard' as const,
                        label: addr.country === 'GB' ? 'Standard — 3–5 days' : 'Standard — 7–14 days',
                        cost: addr.country === 'GB' ? 499 : 1999,
                      },
                      {
                        id: 'express' as const,
                        label: addr.country === 'GB' ? 'Express — 1–2 days' : 'Express — 3–5 days',
                        cost: addr.country === 'GB' ? 999 : 2999,
                      },
                    ].map((opt) => (
                      <label key={opt.id} className="flex items-center justify-between border border-kvrn-border p-4 cursor-pointer hover:border-kvrn-border-strong transition-colors">
                        <div className="flex items-center gap-3">
                          <input
                            type="radio"
                            name="shipping-method"
                            value={opt.id}
                            checked={shipping === opt.id}
                            onChange={() => setShipping(opt.id)}
                            className="accent-kvrn-text"
                            aria-label={opt.label}
                          />
                          <span className="text-[13px] font-light">{opt.label}</span>
                        </div>
                        <span className="text-[13px] font-light">{formatPrice(opt.cost)}</span>
                      </label>
                    ))}
                  </div>

                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => {
                      if (addr.firstName && addr.address1 && addr.city && addr.postcode) {
                        setStep('payment')
                      }
                    }}
                    disabled={!addr.firstName || !addr.address1 || !addr.city || !addr.postcode}
                  >
                    Continue to payment
                  </Button>
                </div>
              ) : step === 'payment' ? (
                <div className="text-[14px] text-kvrn-muted space-y-0.5">
                  <p>{addr.firstName} {addr.lastName}</p>
                  <p>{addr.address1}{addr.address2 && `, ${addr.address2}`}</p>
                  <p>{addr.city}, {addr.postcode}</p>
                  <p>{COUNTRIES.find(c => c.code === addr.country)?.name}</p>
                </div>
              ) : null}
            </section>

            <div className="rule" />

            {/* ─── Payment ─── */}
            {step === 'payment' && (
              <section aria-labelledby="payment-heading">
                <h2 id="payment-heading" className="label-11 mb-4">Payment</h2>

                {/* Stripe Elements will mount here */}
                <div className="border border-kvrn-border p-5 mb-4 bg-kvrn-bg-raised">
                  <p className="text-[13px] text-kvrn-muted text-center py-4">
                    Stripe Elements will render here.
                    <br />
                    <span className="text-[11px]">
                      Connect NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to activate.
                    </span>
                  </p>
                  {/* Production: replace the above with:
                  <PaymentElement options={{ layout: 'tabs' }} />
                  */}
                </div>

                <div className="flex items-center gap-2 mb-4 text-[12px] text-kvrn-muted">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <rect x="1" y="4" width="12" height="9" rx="1" stroke="currentColor" strokeWidth="1"/>
                    <path d="M4 4V3a3 3 0 016 0v1" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  </svg>
                  <span>Secured by Stripe. Your card details are never stored.</span>
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  onClick={() => {
                    // Production: stripe.confirmPayment({ elements, ... })
                    alert(`Demo mode.\n\nIn production, Stripe Elements processes payment here.\n\nTotal: ${formatPrice(totalPence)}`)
                  }}
                >
                  Pay {formatPrice(totalPence)}
                </Button>
              </section>
            )}
          </div>

          {/* ─── Right: Order summary ─── */}
          <aside
            className="lg:sticky lg:top-[72px] border border-kvrn-border p-6 space-y-5 bg-kvrn-bg-raised"
            aria-label="Order summary"
          >
            <h2 className="label-11">Order summary</h2>

            {/* Items */}
            <ul className="space-y-4 divide-y divide-kvrn-border">
              {items.map((item) => (
                <li key={item.cartItemId} className="flex items-start gap-4 pt-4 first:pt-0">
                  <div className="relative w-16 h-[85px] flex-shrink-0 bg-kvrn-bg overflow-hidden">
                    {item.image ? (
                      <Image src={item.image} alt={item.productName} fill sizes="64px" className="object-cover" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundColor: item.colorHex + '30' }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-light leading-snug">{item.productName}</p>
                    <p className="text-[12px] text-kvrn-muted mt-0.5">
                      {item.colorName} / {item.size} · Qty {item.quantity}
                    </p>
                  </div>
                  <p className="text-[13px] font-light flex-shrink-0">
                    {formatPrice(item.price * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>

            <div className="rule" />

            {/* Totals */}
            <div className="space-y-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-kvrn-muted">Subtotal</span>
                <span className="font-light">{formatPrice(subtotalPence)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-kvrn-muted">Shipping</span>
                <span className="font-light">{step === 'contact' ? 'Calculated next' : formatPrice(shippingCost)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-kvrn-border text-[15px]">
                <span className="font-light">Total</span>
                <div className="text-right">
                  <span className="font-light">{step === 'contact' ? formatPrice(subtotalPence) + '+' : formatPrice(totalPence)}</span>
                  {step !== 'contact' && (
                    <p className="text-[11px] text-kvrn-muted mt-0.5">incl. VAT {formatPrice(vatPence)}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Trust */}
            <div className="pt-2 space-y-2 text-[12px] text-kvrn-muted border-t border-kvrn-border">
              <p>Free returns within 30 days</p>
              <p>Tracked delivery on every order</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
