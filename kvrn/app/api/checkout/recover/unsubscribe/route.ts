// /api/checkout/recover/unsubscribe?t=<token>
//   GET   shows a confirmation page (a mail scanner pre-fetching the link must not unsubscribe anyone)
//   POST  performs it — also the RFC 8058 one-click target used by the List-Unsubscribe header.
// Adds the address to the recovery-email suppression list AND runs the existing marketing
// unsubscribe. Works whatever the feature flag says (an unsubscribe must never be blocked).
// Transactional emails (order confirmation, shipping) are unaffected.
import { type NextRequest, NextResponse } from 'next/server'
import { abandonedService } from '@/lib/abandoned-checkout-runtime'

export const dynamic = 'force-dynamic'

const HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${title} — KVRN</title>
  <style>
    body { font-family: -apple-system, Helvetica Neue, sans-serif; background: #FAFAF8; color: #1A1A1A; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .wrap { max-width: 400px; padding: 40px 24px; text-align: center; }
    h1 { font-weight: 300; font-size: 28px; letter-spacing: -0.02em; margin-bottom: 16px; }
    p { font-size: 14px; color: #6B6B6B; line-height: 1.6; }
    a { color: #1A1A1A; }
    button { margin-top: 16px; background: #1A1A1A; color: #fff; border: 0; padding: 12px 24px; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`, { status, headers: HEADERS })
}

export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get('t') ?? ''
  if (!/^[A-Za-z0-9._-]{10,400}$/.test(t)) {
    return page('Link not valid', '<h1>This link isn’t valid.</h1><p>It may be incomplete or out of date.</p><p style="margin-top:24px"><a href="/">Return to kvrn.shop</a></p>', 400)
  }
  return page('Unsubscribe', `<h1>Unsubscribe?</h1>
<p>You will stop receiving cart reminders and marketing emails from KVRN.</p>
<form method="POST" action="/api/checkout/recover/unsubscribe?t=${encodeURIComponent(t)}"><button type="submit">Unsubscribe</button></form>
<p style="font-size:12px;color:#9B9B9B;margin-top:16px;">Order confirmations and shipping updates are not affected.</p>`)
}

export async function POST(req: NextRequest) {
  const t = req.nextUrl.searchParams.get('t') ?? ''
  const r = await abandonedService.unsubscribeByToken(t)
  if (r.status === 'ok') {
    return page('Unsubscribed', `<h1>Unsubscribed.</h1>
<p>You won’t receive cart reminders or marketing emails from KVRN.</p>
<p style="font-size:12px;color:#9B9B9B;margin-top:8px;">Order confirmations and shipping updates are transactional and are not affected.</p>
<p style="margin-top:24px;"><a href="/">Return to kvrn.shop</a></p>`)
  }
  if (r.status === 'unconfigured') {
    return page('Unavailable', '<h1>Temporarily unavailable.</h1><p>Please try again later, or write to support@kvrn.shop and we will remove you.</p>', 503)
  }
  return page('Link not valid', '<h1>This link isn’t valid.</h1><p>It may have expired. Write to support@kvrn.shop and we will remove you.</p><p style="margin-top:24px"><a href="/">Return to kvrn.shop</a></p>', 400)
}
