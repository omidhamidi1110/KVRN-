// lib/email.ts — KVRN transactional email templates
// Active: order_confirmation (V51.1)
// Inactive (V51.2+): shippingConfirmation, reviewRequest, waitlistConfirmation

import { formatCheckoutPrice } from './format-money'
import { getSiteOrigin }       from './site-origin'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrderConfirmationData {
  orderNumber:      string
  customerName:     string | null
  customerEmail:    string
  lineItems:        OrderLineItem[]
  subtotalCents:    number
  shippingCents:    number
  totalCents:       number
  shippingMethod:   string | null
  shippingAddress:  V50ShippingAddress | null
}

export interface OrderLineItem {
  productName:     string
  color:           string
  size:            string
  quantity:        number
  unitPriceCents:  number
  lineTotalCents:  number
}

export interface V50ShippingAddress {
  firstName:  string
  lastName:   string
  line1:      string
  line2?:     string | null
  city:       string
  state:      string
  postalCode: string
  country:    string
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const S = {
  body:   'font-family:-apple-system,Helvetica Neue,sans-serif;color:#1A1A1A;background:#FAFAF8;margin:0;padding:0;',
  wrap:   'max-width:560px;margin:0 auto;padding:48px 24px;',
  logo:   'font-size:15px;letter-spacing:0.1em;text-transform:uppercase;font-weight:300;text-decoration:none;color:#1A1A1A;',
  h1:     'font-size:24px;font-weight:300;letter-spacing:-0.02em;margin:40px 0 8px;',
  p:      'font-size:14px;color:#6B6B6B;line-height:1.6;margin:0 0 16px;',
  rule:   'border:none;border-top:1px solid #E8E5E0;margin:32px 0;',
  label:  'font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#9B9B9B;',
  value:  'font-size:14px;color:#1A1A1A;font-weight:300;',
  total:  'font-size:15px;font-weight:300;padding-top:8px;',
  footer: 'margin-top:48px;font-size:11px;color:#9B9B9B;letter-spacing:0.05em;',
}

// ── Active: order confirmation ─────────────────────────────────────────────────

export function orderConfirmationHTML(data: OrderConfirmationData, siteOrigin?: string): string {
  const origin   = siteOrigin ?? getSiteOrigin() ?? 'https://kvrn.shop'
  const firstName = data.customerName?.split(' ')[0] ?? 'there'

  const itemRows = data.lineItems.map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #E8E5E0;">
        <span style="${S.value}">${escHtml(item.productName)}</span><br>
        <span style="${S.label}">${escHtml(item.color)} / ${escHtml(item.size)}${item.quantity > 1 ? ` × ${item.quantity}` : ''}</span>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #E8E5E0;text-align:right;vertical-align:top;">
        <span style="${S.value}">${formatCheckoutPrice(item.lineTotalCents)}</span>
      </td>
    </tr>`).join('')

  const addr = data.shippingAddress
  const addrHtml = addr ? `
    <p style="${S.label}">Shipping to</p>
    <p style="${S.value};margin-top:4px;line-height:1.8;">
      ${escHtml(addr.firstName)} ${escHtml(addr.lastName)}<br>
      ${escHtml(addr.line1)}${addr.line2 ? `<br>${escHtml(addr.line2)}` : ''}<br>
      ${escHtml(addr.city)}, ${escHtml(addr.state)} ${escHtml(addr.postalCode)}<br>
      ${escHtml(addr.country)}
    </p>` : ''

  const shippingLabel = data.shippingMethod === 'express'
    ? 'Express Shipping'
    : 'Standard Shipping'

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${escHtml(data.orderNumber)} confirmed</title></head>
<body style="${S.body}">
  <div style="${S.wrap}">
    <a href="${origin}" style="${S.logo}">KVRN</a>

    <h1 style="${S.h1}">Order confirmed.</h1>
    <p style="${S.p}">Hi ${escHtml(firstName)}, your order ${escHtml(data.orderNumber)} is confirmed. We'll email you when it ships.</p>

    <hr style="${S.rule}">

    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E8E5E0;">
      ${itemRows}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
      <tr>
        <td style="${S.p}">Subtotal</td>
        <td style="${S.p};text-align:right;">${formatCheckoutPrice(data.subtotalCents)}</td>
      </tr>
      <tr>
        <td style="${S.p}">${shippingLabel}</td>
        <td style="${S.p};text-align:right;">${formatCheckoutPrice(data.shippingCents)}</td>
      </tr>
      <tr>
        <td style="${S.total}">Total</td>
        <td style="${S.total};text-align:right;">${formatCheckoutPrice(data.totalCents)}</td>
      </tr>
    </table>

    <hr style="${S.rule}">

    ${addrHtml}

    <hr style="${S.rule}">

    <p style="${S.p}">
      <a href="${origin}/support/track" style="color:#1A1A1A;">Track your order</a>
      &nbsp;&middot;&nbsp;
      Questions? <a href="mailto:support@kvrn.shop" style="color:#1A1A1A;">support@kvrn.shop</a>
    </p>

    <p style="${S.footer}">
      &copy; KVRN &middot; <a href="${origin}" style="color:#9B9B9B;">kvrn.shop</a>
    </p>
  </div>
</body>
</html>`
}

export function orderConfirmationSubject(orderNumber: string): string {
  return `KVRN — Order ${orderNumber} confirmed`
}

// ── Active: shipping confirmation (V51.3) ────────────────────────────────────

export interface ShippingConfirmationData {
  orderNumber:     string
  customerName:    string | null
  customerEmail:   string
  carrier:         string
  trackingNumber:  string
  shippedAt:       string | null
  shippingAddress: V50ShippingAddress | null
}

export function shippingConfirmationHTML(data: ShippingConfirmationData, siteOrigin?: string): string {
  const origin    = siteOrigin ?? getSiteOrigin() ?? 'https://kvrn.shop'
  const firstName = data.customerName?.split(' ')[0] ?? 'there'

  const addrHtml = data.shippingAddress ? `
    <p style="${S.label}">Shipping to</p>
    <p style="${S.value};margin-top:4px;line-height:1.8;">
      ${escHtml(data.shippingAddress.firstName)} ${escHtml(data.shippingAddress.lastName)}<br>
      ${escHtml(data.shippingAddress.line1)}${data.shippingAddress.line2 ? `<br>${escHtml(data.shippingAddress.line2)}` : ''}<br>
      ${escHtml(data.shippingAddress.city)}, ${escHtml(data.shippingAddress.state)} ${escHtml(data.shippingAddress.postalCode)}
    </p>` : ''

  const shippedDate = data.shippedAt
    ? new Date(data.shippedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${escHtml(data.orderNumber)} shipped</title></head>
<body style="${S.body}">
  <div style="${S.wrap}">
    <a href="${origin}" style="${S.logo}">KVRN</a>

    <h1 style="${S.h1}">Your order is on its way.</h1>
    <p style="${S.p}">Hi ${escHtml(firstName)}, your order ${escHtml(data.orderNumber)} has shipped.</p>

    <hr style="${S.rule}">

    <p style="${S.label}">Carrier</p>
    <p style="${S.value};margin-top:4px;">${escHtml(data.carrier)}</p>

    <p style="${S.label};margin-top:16px;">Tracking number</p>
    <p style="${S.value};margin-top:4px;">${escHtml(data.trackingNumber)}</p>

    ${shippedDate ? `<p style="${S.label};margin-top:16px;">Shipped on</p>
    <p style="${S.value};margin-top:4px;">${shippedDate}</p>` : ''}

    ${addrHtml}

    <hr style="${S.rule}">

    <p style="${S.p}">
      <a href="${origin}/support/track" style="color:#1A1A1A;">Track your order</a>
      &nbsp;&middot;&nbsp;
      Questions? <a href="mailto:support@kvrn.shop" style="color:#1A1A1A;">support@kvrn.shop</a>
    </p>

    <p style="${S.footer}">
      &copy; KVRN &middot; <a href="${origin}" style="color:#9B9B9B;">kvrn.shop</a>
    </p>
  </div>
</body>
</html>`
}

export function shippingConfirmationSubject(orderNumber: string): string {
  return `KVRN — Order ${orderNumber} has shipped`
}

// ── Inactive templates (future phases) ────────────────────────────────────────

function _reviewRequestHTML(_data: unknown): string { return '' }

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
         .replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}

// ── Legacy stubs — not activated (V51.2+) ────────────────────────────────────

export async function sendEmail(_opts: {
  to: string; subject: string; html: string; replyTo?: string
}): Promise<void> {
  // TODO V51.2: wire to Resend when waitlist email is activated
  console.warn('[email] sendEmail stub called — not yet implemented.')
}

export function waitlistConfirmationHTML(_data: { email: string; phone?: string; smsConsent?: boolean; dropId?: string; source?: string }): string {
  return ''
}
