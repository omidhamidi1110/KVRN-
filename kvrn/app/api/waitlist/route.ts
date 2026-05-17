import { NextRequest, NextResponse } from 'next/server'
import { sendEmail, waitlistConfirmationHTML } from '@/lib/email'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      email,
      phone,
      smsConsent = false,
      dropId  = 'drop_001',
      source  = 'unknown',
    } = body

    // ── Validate ───────────────────────────────────────────────────────────
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'A valid email address is required.' }, { status: 400 })
    }

    // ── Neon DB upsert ─────────────────────────────────────────────────────
    // Uncomment once @neondatabase/serverless is installed and DATABASE_URL is set:
    //
    // import { neon } from '@neondatabase/serverless'
    // const db = neon(process.env.DATABASE_URL!)
    //
    // await db`
    //   INSERT INTO customers (
    //     id, email, phone,
    //     email_consent, email_consent_at, email_consent_source,
    //     sms_consent,   sms_consent_at,   sms_consent_source,
    //     segment, acquisition_source, created_at
    //   )
    //   VALUES (
    //     gen_random_uuid()::text,
    //     ${email.trim().toLowerCase()},
    //     ${phone?.trim() || null},
    //     true,  NOW(), ${source},
    //     ${smsConsent}, ${smsConsent ? 'NOW()' : null}, ${smsConsent ? source : null},
    //     'B', ${source}, NOW()
    //   )
    //   ON CONFLICT (email) DO UPDATE
    //     SET updated_at          = NOW(),
    //         email_consent       = true,
    //         email_consent_at    = COALESCE(customers.email_consent_at, NOW()),
    //         sms_consent         = EXCLUDED.sms_consent,
    //         sms_consent_at      = CASE WHEN EXCLUDED.sms_consent THEN COALESCE(customers.sms_consent_at, NOW()) ELSE customers.sms_consent_at END,
    //         phone               = COALESCE(EXCLUDED.phone, customers.phone)
    // `
    //
    // // Add to drop waitlist
    // await db`
    //   INSERT INTO drop_waitlist (id, customer_id, drop_id, created_at)
    //   SELECT gen_random_uuid()::text, id, ${dropId}, NOW()
    //   FROM customers WHERE email = ${email.trim().toLowerCase()}
    //   ON CONFLICT DO NOTHING
    // `

    // ── Confirmation email ─────────────────────────────────────────────────
    await sendEmail({
      to:      email.trim(),
      subject: "You're on the list.",
      html:    waitlistConfirmationHTML({ email: email.trim(), dropId }),
    })

    // ── SMS confirmation (opt-in only) ─────────────────────────────────────
    // Uncomment once twilio is installed:
    //
    // if (smsConsent && phone?.trim()) {
    //   const twilio = require('twilio')(
    //     process.env.TWILIO_ACCOUNT_SID,
    //     process.env.TWILIO_AUTH_TOKEN
    //   )
    //   await twilio.messages.create({
    //     body: `You're on the KVRN list. First to know about Drop 002. Reply STOP to unsubscribe.`,
    //     from: process.env.TWILIO_PHONE_NUMBER,
    //     to:   phone.trim(),
    //   })
    // }

    console.log(`[waitlist] ${email} | drop: ${dropId} | source: ${source} | sms: ${smsConsent}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[waitlist] Error:', err)
    return NextResponse.json({ success: false, error: 'Server error. Please try again.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
