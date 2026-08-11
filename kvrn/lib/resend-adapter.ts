// lib/resend-adapter.ts — Resend email provider adapter
// Dependency-injectable for tests; never silently succeeds in production without a real key.

export interface EmailMessage {
  from:         string
  replyTo:      string
  to:           string
  subject:      string
  html:         string
  idempotencyKey?: string
  // Deliberately no List-Unsubscribe — transactional confirmation only
}

export interface SendResult {
  ok:                true
  providerMessageId: string
}

export interface SendError {
  ok:      false
  message: string   // safe, no PII
}

export type SendOutcome = SendResult | SendError

export interface EmailProvider {
  send(msg: EmailMessage): Promise<SendOutcome>
}

// ── Resend production adapter ─────────────────────────────────────────────────

export function createResendAdapter(apiKey: string): EmailProvider {
  return {
    async send(msg: EmailMessage): Promise<SendOutcome> {
      const body: Record<string, unknown> = {
        from:     msg.from,
        reply_to: msg.replyTo,
        to:       [msg.to],
        subject:  msg.subject,
        html:     msg.html,
      }

      const headers: Record<string, string> = {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      }
      if (msg.idempotencyKey) {
        headers['Idempotency-Key'] = msg.idempotencyKey
      }

      let res: Response
      try {
        res = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers,
          body:    JSON.stringify(body),
        })
      } catch (err: any) {
        return { ok: false, message: 'Network error contacting email provider.' }
      }

      if (!res.ok) {
        // Do not log full response body — may contain provider internals
        return { ok: false, message: `Email provider returned HTTP ${res.status}.` }
      }

      let data: any
      try { data = await res.json() } catch {
        return { ok: false, message: 'Email provider returned unreadable response.' }
      }

      const id: string | undefined = data?.id
      if (!id) return { ok: false, message: 'Email provider returned no message ID.' }

      return { ok: true, providerMessageId: id }
    },
  }
}

// ── Factory — returns real adapter or throws clearly ─────────────────────────

export function getEmailProvider(): EmailProvider {
  const key = process.env.RESEND_API_KEY ?? ''
  if (!key) {
    throw new Error('RESEND_API_KEY is not set. Email sending is not configured.')
  }
  return createResendAdapter(key)
}
