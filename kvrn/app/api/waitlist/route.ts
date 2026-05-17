import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email, phone, smsConsent, dropId = 'drop_001', source = 'unknown' } = body

    // ─── Validation ────────────────────────────────────────────────
    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Email is required.' },
        { status: 400 }
      )
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { success: false, error: 'Invalid email address.' },
        { status: 400 }
      )
    }

    // ─── Database insert ────────────────────────────────────────────
    // TODO: Connect to Neon Postgres
    // import { neon } from '@neondatabase/serverless'
    // const db = neon(process.env.DATABASE_URL!)
    // await db`
    //   INSERT INTO customers (id, email, phone, sms_consent, sms_consent_source, email_consent, email_consent_source, segment, created_at)
    //   VALUES (gen_random_uuid(), ${email}, ${phone || null}, ${smsConsent}, ${source}, true, ${source}, 'B', NOW())
    //   ON CONFLICT (email) DO UPDATE
    //   SET updated_at = NOW()
    // `

    // ─── Confirmation email via Resend ──────────────────────────────
    // TODO: Connect Resend
    // import { Resend } from 'resend'
    // const resend = new Resend(process.env.RESEND_API_KEY)
    // await resend.emails.send({
    //   from: 'KVRN <hello@kvrn.com>',
    //   to: email,
    //   subject: "You're on the list.",
    //   html: `<p>KVRN Drop 001 is available now. Drop 002 is coming. You'll be first.</p>`,
    // })

    // ─── SMS confirmation via Twilio ────────────────────────────────
    // TODO: Only if smsConsent === true and phone provided
    // import twilio from 'twilio'
    // const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    // if (smsConsent && phone) {
    //   await client.messages.create({
    //     body: "You're on the KVRN list. First to know about Drop 002.",
    //     from: process.env.TWILIO_PHONE_NUMBER,
    //     to: phone,
    //   })
    // }

    console.log(`[waitlist] New signup: ${email} | source: ${source} | drop: ${dropId} | sms: ${smsConsent}`)

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('[waitlist] Error:', err)
    return NextResponse.json(
      { success: false, error: 'Internal server error.' },
      { status: 500 }
    )
  }
}

// Block non-POST methods
export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
}
