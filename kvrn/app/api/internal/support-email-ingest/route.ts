// POST /api/internal/support-email-ingest
//
// Machine-to-machine route called by the Email Worker (cloudflare-cron-wrapper.js →
// lib/support-email-handler.ts) through openNextWorker.fetch — never over the public network.
// It is NOT an admin route: it authenticates with its own secret, SUPPORT_EMAIL_INGEST_SECRET.
//
// Idempotent (a redelivered email returns { duplicate: true } and changes nothing), POST only,
// and it never logs an address, subject or body. Responses are generic.
// A NEW (non-duplicate) message also triggers the fail-open owner push "KVRN SUPPORT" (lib/owner-notifications).
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { notifySupportEmail } from '@/lib/owner-notifications'
import {
  SupportError, SUPPORT_LIMITS, buildInboundEmailInput, constantTimeEqual, createSupportService,
} from '@/lib/support-inbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const secret = process.env.SUPPORT_EMAIL_INGEST_SECRET ?? ''
  if (!secret) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503, headers: NO_STORE })
  }
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  let raw: string
  try { raw = await req.text() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }
  if (raw.length > SUPPORT_LIMITS.INGEST_BODY_CHARS) {
    return NextResponse.json({ error: 'Payload too large.' }, { status: 413, headers: NO_STORE })
  }

  let payload: unknown
  try { payload = JSON.parse(raw) } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }

  try {
    const input = buildInboundEmailInput(payload)
    const r = await createSupportService(sql).ingestInboundEmail(input)
    // Owner push ONLY for a newly stored message from the email path. A redelivered email comes back
    // duplicate=true and never notifies. The push can never change the outcome: the message is already
    // stored, notifySupportEmail is fail-open (never throws, 2s bound), and the .catch is belt and braces.
    if (!r.duplicate) {
      await notifySupportEmail({ fromName: input.fromName, subject: input.subject }).catch(() => {})
    }
    return NextResponse.json(
      { ok: true, duplicate: r.duplicate, threadCreated: r.threadCreated, matchedBy: r.matchedBy },
      { headers: NO_STORE })
  } catch (err) {
    if (err instanceof SupportError && err.status >= 400 && err.status < 500) {
      return NextResponse.json({ error: 'Rejected.', code: err.code }, { status: err.status, headers: NO_STORE })
    }
    console.error('[support-ingest] storage failure', err instanceof SupportError ? err.code : 'unexpected')
    return NextResponse.json({ error: 'Could not store message.' }, { status: 500, headers: NO_STORE })
  }
}
