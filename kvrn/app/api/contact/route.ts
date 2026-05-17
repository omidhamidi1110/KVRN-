import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { firstName, lastName, email, orderNumber, subject, message } = body

    // ─── Validation ────────────────────────────────────────────────
    if (!firstName || !lastName || !email || !subject || !message) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields.' },
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

    // ─── Send email via Resend ──────────────────────────────────────
    // TODO: Connect Resend
    // import { Resend } from 'resend'
    // const resend = new Resend(process.env.RESEND_API_KEY)
    //
    // // Notify KVRN team
    // await resend.emails.send({
    //   from: 'KVRN Website <noreply@kvrn.com>',
    //   to: 'hello@kvrn.com',
    //   replyTo: email,
    //   subject: `Contact: ${subject} — ${firstName} ${lastName}`,
    //   html: `
    //     <p><strong>From:</strong> ${firstName} ${lastName} &lt;${email}&gt;</p>
    //     <p><strong>Subject:</strong> ${subject}</p>
    //     ${orderNumber ? `<p><strong>Order:</strong> ${orderNumber}</p>` : ''}
    //     <hr>
    //     <p>${message.replace(/\n/g, '<br>')}</p>
    //   `,
    // })
    //
    // // Auto-reply to customer
    // await resend.emails.send({
    //   from: 'KVRN <hello@kvrn.com>',
    //   to: email,
    //   subject: 'We received your message.',
    //   html: `
    //     <p>Hi ${firstName},</p>
    //     <p>We've received your message and will respond within 24 hours.</p>
    //     <p>— KVRN</p>
    //   `,
    // })

    console.log(`[contact] ${firstName} ${lastName} <${email}> — ${subject}`)
    if (orderNumber) console.log(`[contact] Order: ${orderNumber}`)

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('[contact] Error:', err)
    return NextResponse.json(
      { success: false, error: 'Internal server error.' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
}
