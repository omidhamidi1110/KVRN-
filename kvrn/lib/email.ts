// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SYSTEM — Resend
//
// SETUP:
//   npm install resend
//   Add RESEND_API_KEY to .env.local
//   Verify kvrn.shop domain at resend.com/domains (or route kvrn.shop through Cloudflare Email Routing to forward to your inbox)
//
// All transactional emails are plain-HTML, minimal, on-brand.
// No heavy templates, no image-heavy emails — fast and reliable.
// ─────────────────────────────────────────────────────────────────────────────

interface OrderEmailData {
  orderNumber:     string
  customerName:    string
  customerEmail:   string
  lineItems:       Array<{ name: string; color: string; size: string; price: number; quantity: number }>
  subtotalPence:   number
  shippingPence:   number
  totalPence:      number
  shippingAddress: {
    firstName: string; lastName: string
    address1: string; address2?: string
    city: string; postcode: string; country: string
  }
  estimatedDelivery?: string
}

interface ShippingEmailData extends OrderEmailData {
  carrier:         string
  trackingNumber:  string
  trackingUrl:     string
}

// ─── SHARED STYLES ───────────────────────────────────────────────────────────
const STYLES = {
  body:    'font-family: -apple-system, Helvetica Neue, sans-serif; color: #1A1A1A; background: #FAFAF8; margin: 0; padding: 0;',
  wrapper: 'max-width: 560px; margin: 0 auto; padding: 48px 24px;',
  logo:    'font-size: 15px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 300; text-decoration: none; color: #1A1A1A;',
  h1:      'font-size: 24px; font-weight: 300; letter-spacing: -0.02em; margin: 40px 0 8px;',
  p:       'font-size: 14px; color: #6B6B6B; line-height: 1.6; margin: 0 0 16px;',
  rule:    'border: none; border-top: 1px solid #E8E5E0; margin: 32px 0;',
  label:   'font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #9B9B9B;',
  value:   'font-size: 14px; color: #1A1A1A; font-weight: 300;',
  button:  'display: inline-block; padding: 14px 28px; background: #1A1A1A; color: #FAFAF8; text-decoration: none; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 300;',
  footer:  'margin-top: 48px; font-size: 11px; color: #9B9B9B; letter-spacing: 0.05em;',
}

function fmt(pence: number) {
  return `£${(pence / 100).toFixed(0)}`
}

function lineItemsHTML(items: OrderEmailData['lineItems']) {
  return items.map(item => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #E8E5E0;">
        <span style="${STYLES.value}">${item.name}</span><br>
        <span style="${STYLES.label}">${item.color} / ${item.size}</span>
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #E8E5E0; text-align: right; vertical-align: top;">
        <span style="${STYLES.value}">${fmt(item.price * item.quantity)}</span>
      </td>
    </tr>
  `).join('')
}

// ─── ORDER CONFIRMATION ───────────────────────────────────────────────────────
export function orderConfirmationHTML(data: OrderEmailData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.wrapper}">
    <a href="https://kvrn.com" style="${STYLES.logo}">KVRN</a>

    <h1 style="${STYLES.h1}">Order confirmed.</h1>
    <p style="${STYLES.p}">Hi ${data.customerName.split(' ')[0]}, your order #${data.orderNumber} is confirmed. We'll email you when it ships.</p>

    <hr style="${STYLES.rule}">

    <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #E8E5E0;">
      ${lineItemsHTML(data.lineItems)}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 16px;">
      <tr>
        <td style="${STYLES.p}">Subtotal</td>
        <td style="${STYLES.p}; text-align: right;">${fmt(data.subtotalPence)}</td>
      </tr>
      <tr>
        <td style="${STYLES.p}">Shipping</td>
        <td style="${STYLES.p}; text-align: right;">${fmt(data.shippingPence)}</td>
      </tr>
      <tr>
        <td style="font-size: 15px; font-weight: 300; padding-top: 8px;">Total</td>
        <td style="font-size: 15px; font-weight: 300; text-align: right; padding-top: 8px;">${fmt(data.totalPence)}</td>
      </tr>
    </table>

    <hr style="${STYLES.rule}">

    <p style="${STYLES.label}">Shipping to</p>
    <p style="${STYLES.value}; margin-top: 4px; line-height: 1.6;">
      ${data.shippingAddress.firstName} ${data.shippingAddress.lastName}<br>
      ${data.shippingAddress.address1}${data.shippingAddress.address2 ? '<br>' + data.shippingAddress.address2 : ''}<br>
      ${data.shippingAddress.city}, ${data.shippingAddress.postcode}<br>
      ${data.shippingAddress.country}
    </p>

    ${data.estimatedDelivery ? `
    <p style="${STYLES.label}; margin-top: 16px;">Estimated delivery</p>
    <p style="${STYLES.value}; margin-top: 4px;">${data.estimatedDelivery}</p>
    ` : ''}

    <hr style="${STYLES.rule}">

    <p style="${STYLES.p}">Questions? Reply to this email or contact <a href="mailto:support@kvrn.shop" style="color: #1A1A1A;">support@kvrn.shop</a>.</p>

    <p style="${STYLES.footer}">
      © KVRN · <a href="https://kvrn.com" style="color: #9B9B9B;">kvrn.com</a> ·
      <a href="https://kvrn.com/support/shipping-returns" style="color: #9B9B9B;">Returns</a>
    </p>
  </div>
</body>
</html>`
}

// ─── SHIPPING CONFIRMATION ────────────────────────────────────────────────────
export function shippingConfirmationHTML(data: ShippingEmailData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.wrapper}">
    <a href="https://kvrn.com" style="${STYLES.logo}">KVRN</a>

    <h1 style="${STYLES.h1}">Your order is on its way.</h1>
    <p style="${STYLES.p}">Order #${data.orderNumber} has shipped via ${data.carrier}.</p>

    <a href="${data.trackingUrl}" style="${STYLES.button}">Track your order</a>

    <hr style="${STYLES.rule}">

    <p style="${STYLES.label}">Tracking number</p>
    <p style="${STYLES.value}; margin-top: 4px;">${data.trackingNumber}</p>

    ${data.estimatedDelivery ? `
    <p style="${STYLES.label}; margin-top: 16px;">Estimated delivery</p>
    <p style="${STYLES.value}; margin-top: 4px;">${data.estimatedDelivery}</p>
    ` : ''}

    <hr style="${STYLES.rule}">

    <p style="${STYLES.p}">
      If anything isn't right when it arrives, email <a href="mailto:support@kvrn.shop" style="color: #1A1A1A;">support@kvrn.shop</a>.
      Free returns within 30 days.
    </p>

    <p style="${STYLES.footer}">
      © KVRN · <a href="https://kvrn.com" style="color: #9B9B9B;">kvrn.com</a>
    </p>
  </div>
</body>
</html>`
}

// ─── REVIEW REQUEST (Day 14 post-delivery) ────────────────────────────────────
export function reviewRequestHTML(data: {
  firstName: string
  orderNumber: string
  reviewUrl: string
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.wrapper}">
    <a href="https://kvrn.com" style="${STYLES.logo}">KVRN</a>

    <h1 style="${STYLES.h1}">One question.</h1>
    <p style="${STYLES.p}">${data.firstName},</p>
    <p style="${STYLES.p}">You've had the hoodie for two weeks. How does it wear?</p>

    <a href="${data.reviewUrl}" style="${STYLES.button}">Leave a review</a>

    <hr style="${STYLES.rule}">

    <p style="${STYLES.p}">We read every response. Your feedback helps the next person find the right size.</p>

    <p style="${STYLES.footer}">
      © KVRN · Order #${data.orderNumber}
    </p>
  </div>
</body>
</html>`
}

// ─── WAITLIST CONFIRMATION ────────────────────────────────────────────────────
export function waitlistConfirmationHTML(data: {
  email: string
  dropId: string
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.wrapper}">
    <a href="https://kvrn.com" style="${STYLES.logo}">KVRN</a>

    <h1 style="${STYLES.h1}">You're on the list.</h1>
    <p style="${STYLES.p}">We'll be in touch when the next drop goes live. You'll hear before anyone else.</p>

    <hr style="${STYLES.rule}">

    <p style="${STYLES.p}">Questions? <a href="mailto:support@kvrn.shop" style="color: #1A1A1A;">support@kvrn.shop</a></p>

    <p style="${STYLES.footer}">
      © KVRN · <a href="https://kvrn.com/api/unsubscribe?email=${encodeURIComponent(data.email)}" style="color: #9B9B9B;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`
}

// ─── DROP LAUNCH EMAIL ────────────────────────────────────────────────────────
export function dropLaunchHTML(data: {
  dropId:   string
  products: Array<{ name: string; price: number; url: string }>
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.wrapper}">
    <a href="https://kvrn.com" style="${STYLES.logo}">KVRN</a>

    <h1 style="${STYLES.h1}">${data.dropId.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())} is live.</h1>

    ${data.products.map(p => `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 16px 0; border-top: 1px solid #E8E5E0; padding-top: 16px;">
      <tr>
        <td><a href="${p.url}" style="font-size: 15px; font-weight: 300; color: #1A1A1A; text-decoration: none;">${p.name}</a></td>
        <td style="text-align: right; font-size: 15px; font-weight: 300;">${fmt(p.price)}</td>
      </tr>
    </table>
    `).join('')}

    <a href="https://kvrn.com/shop?utm_source=email&utm_medium=waitlist&utm_campaign=${data.dropId}" style="${STYLES.button}; display: block; text-align: center; margin-top: 32px;">Shop now</a>

    <p style="${STYLES.p}; margin-top: 32px;">Drops sell out. This email was sent to waitlist members first.</p>

    <p style="${STYLES.footer}">
      © KVRN · <a href="https://kvrn.com" style="color: #9B9B9B;">kvrn.com</a>
    </p>
  </div>
</body>
</html>`
}

// ─── SEND HELPER (activate by installing resend) ──────────────────────────────
export async function sendEmail(params: {
  to:      string
  subject: string
  html:    string
  replyTo?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[email] Would send to ${params.to}: "${params.subject}"`)
    }
    return { success: true }
  }

  try {
    // Uncomment when resend is installed:
    // const { Resend } = await import('resend')
    // const resend = new Resend(process.env.RESEND_API_KEY)
    // const { error } = await resend.emails.send({
    //   from:     'KVRN <support@kvrn.shop>',
    //   to:       params.to,
    //   subject:  params.subject,
    //   html:     params.html,
    //   replyTo:  params.replyTo,
    //   headers: {
    //     'List-Unsubscribe': `<https://kvrn.com/api/unsubscribe?email=${encodeURIComponent(params.to)}>`,
    //     'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    //   },
    // })
    // if (error) throw error
    return { success: true }
  } catch (err) {
    console.error('[email] Send failed:', err)
    return { success: false, error: String(err) }
  }
}
