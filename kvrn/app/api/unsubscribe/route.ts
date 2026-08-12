import { NextRequest, NextResponse } from 'next/server'
import { normaliseEmail, unsubscribeByEmail, updateSyncStatus, getPendingSyncs } from '@/lib/marketing-subscribers'
import { syncUnsubscribeFromResend } from '@/lib/resend-marketing'
import { sql } from '@/lib/db'

async function processUnsubscribe(rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail)

  // Mark unsubscribed in Neon (source of truth)
  const wasSubscribed = await unsubscribeByEmail(email)

  // Sync to Resend (best-effort)
  if (wasSubscribed) {
    try {
      // Get the contact ID for this subscriber
      const rows = await sql`
        SELECT id, resend_contact_id AS "resendContactId"
        FROM marketing_subscribers WHERE email = ${email} LIMIT 1
      `
      const row = (rows as any[])[0]
      if (row) {
        const sync = await syncUnsubscribeFromResend({ contactId: row.resendContactId })
        await updateSyncStatus(row.id, sync.ok ? 'synced' : 'failed', null, sync.ok ? null : sync.error)
      }
    } catch (syncErr: any) {
      console.error('[unsubscribe] Resend sync failed (non-fatal):', syncErr?.message?.slice(0, 80))
    }
  }
}

// ─── GET /api/unsubscribe ─────────────────────────────────────────────────────
// One-click unsubscribe from email List-Unsubscribe header and direct links.
// GDPR/PECR: processes immediately; marketing only — transactional emails unaffected.
export async function GET(req: NextRequest) {
  const url   = new URL(req.url)
  const email = url.searchParams.get('email')

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new NextResponse('Missing or invalid email parameter.', { status: 400 })
  }

  try {
    await processUnsubscribe(email)
    console.log(`[unsubscribe] GET: ${normaliseEmail(email)}`)
  } catch (err) {
    console.error('[unsubscribe] GET error:', err)
    // Still show confirmation to user — do not reveal DB errors
  }

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
    <p>You've been removed from our email list. You won't receive marketing emails from KVRN.</p>
    <p style="font-size:12px;color:#9B9B9B;margin-top:8px;">Order confirmations and shipping updates are transactional and are not affected.</p>
    <p style="margin-top: 24px;"><a href="https://kvrn.shop">Return to kvrn.shop</a></p>
  </div>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  )
}

// ─── POST /api/unsubscribe ────────────────────────────────────────────────────
// RFC 8058 List-Unsubscribe-Post one-click handler.
export async function POST(req: NextRequest) {
  try {
    const url   = new URL(req.url)
    const email = url.searchParams.get('email')

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Missing or invalid email.' }, { status: 400 })
    }

    await processUnsubscribe(email)
    console.log(`[unsubscribe] POST: ${normaliseEmail(email)}`)
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('[unsubscribe] POST error:', err)
    return NextResponse.json({ error: 'Server error.' }, { status: 500 })
  }
}
