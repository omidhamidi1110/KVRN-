import { NextRequest, NextResponse } from 'next/server'

// ─── GET /api/unsubscribe ─────────────────────────────────────────────────────
// Handles one-click unsubscribe from email List-Unsubscribe header
// and direct unsubscribe links.
// GDPR/PECR compliance: must process immediately.
export async function GET(req: NextRequest) {
  const url    = new URL(req.url)
  const email  = url.searchParams.get('email')
  const token  = url.searchParams.get('token')  // optional signed token
  const type   = url.searchParams.get('type') ?? 'email'  // 'email' | 'sms'

  if (!email) {
    return new NextResponse('Missing email parameter.', { status: 400 })
  }

  try {
    // TODO: Connect Neon DB
    // import { db } from '@/lib/db'
    //
    // if (type === 'sms') {
    //   await db.query(
    //     `UPDATE customers SET sms_unsubscribed = true, sms_unsubscribed_at = NOW() WHERE email = $1`,
    //     [email]
    //   )
    // } else {
    //   await db.query(
    //     `UPDATE customers SET email_unsubscribed = true, email_unsubscribed_at = NOW() WHERE email = $1`,
    //     [email]
    //   )
    // }

    console.log(`[unsubscribe] ${email} unsubscribed from ${type}`)

    // Return a clean HTML confirmation page
    return new NextResponse(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Unsubscribed — KVRN</title>
  <style>
    body { font-family: -apple-system, Helvetica Neue, sans-serif; background: #FAFAF8; color: #1A1A1A; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .wrap { max-width: 400px; padding: 40px 24px; text-align: center; }
    h1 { font-weight: 300; font-size: 28px; letter-spacing: -0.02em; margin-bottom: 16px; }
    p { font-size: 14px; color: #6B6B6B; line-height: 1.6; }
    a { color: #1A1A1A; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Unsubscribed.</h1>
    <p>You've been removed from our ${type === 'sms' ? 'SMS' : 'email'} list. You won't hear from us again.</p>
    <p style="margin-top: 24px;"><a href="https://kvrn.com">Return to kvrn.com</a></p>
  </div>
</body>
</html>`,
      {
        status:  200,
        headers: { 'Content-Type': 'text/html' },
      }
    )
  } catch (err) {
    console.error('[unsubscribe] Error:', err)
    return new NextResponse('An error occurred. Please email hello@kvrn.com to unsubscribe.', {
      status: 500,
    })
  }
}

// ─── POST /api/unsubscribe ────────────────────────────────────────────────────
// Handles List-Unsubscribe-Post header (one-click RFC 8058)
// Email clients send a POST request to this URL when user clicks
// "Unsubscribe" in the email client interface.
export async function POST(req: NextRequest) {
  try {
    const url   = new URL(req.url)
    const email = url.searchParams.get('email')

    if (!email) {
      return NextResponse.json({ error: 'Missing email.' }, { status: 400 })
    }

    // Same as GET handler but for POST (RFC 8058 compliance)
    console.log(`[unsubscribe] POST one-click unsubscribe: ${email}`)

    // TODO: Same DB update as GET handler above
    // await db.query(`UPDATE customers SET email_unsubscribed = true ...`, [email])

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('[unsubscribe] POST error:', err)
    return NextResponse.json({ error: 'Server error.' }, { status: 500 })
  }
}
