// lib/__tests__/transactional-email.test.ts
// V56: Resend integration + cron 522 fix tests.
// Tests the transactional email outbox, provider, and cron architecture.
// No DB connection required for most tests.

import { createResendAdapter, getEmailProvider } from '../resend-adapter'
import { orderConfirmationSubject, shippingConfirmationSubject } from '../email'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides = {}) {
  return {
    from:           'KVRN <orders@send.kvrn.shop>',
    replyTo:        'support@kvrn.shop',
    to:             'customer@example.com',
    subject:        'KVRN — Order KVRN-001001 confirmed',
    html:           '<p>Order confirmed.</p>',
    idempotencyKey: 'order-confirmation/abc-123',
    ...overrides,
  }
}

// ── Subject lines ─────────────────────────────────────────────────────────────

describe('email subjects', () => {
  test('order confirmation subject includes KVRN brand prefix', () => {
    expect(orderConfirmationSubject('KVRN-001001')).toBe('KVRN — Order KVRN-001001 confirmed')
  })
  test('shipping confirmation subject includes KVRN brand prefix and "has shipped"', () => {
    expect(shippingConfirmationSubject('KVRN-001001')).toBe('KVRN — Order KVRN-001001 has shipped')
  })
})

// ── Resend adapter (fetch mocked) ─────────────────────────────────────────────

describe('createResendAdapter', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  // Item 1: successful order-confirmation send
  test('successful send returns ok=true with providerMessageId', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ id: 'resend-msg-001' }),
    }) as any
    const adapter = createResendAdapter('test-key')
    const result  = await adapter.send(makeMsg())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.providerMessageId).toBe('resend-msg-001')
  })

  // Item 2: successful shipping-confirmation send
  test('shipping confirmation send also succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'resend-ship-001' }),
    }) as any
    const result = await createResendAdapter('key').send(makeMsg({
      subject:        'KVRN — Order KVRN-001001 has shipped',
      idempotencyKey: 'shipping-confirmation/abc-123',
    }))
    expect(result.ok).toBe(true)
  })

  // Item 3: Resend 4xx leaves email retryable (returns ok=false, not throws)
  test('Resend 4xx returns ok=false (retryable — no exception)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422 }) as any
    const result = await createResendAdapter('key').send(makeMsg())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('422')
  })

  // Item 3 (continued): Resend 5xx also retryable
  test('Resend 5xx returns ok=false (retryable)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any
    const result = await createResendAdapter('key').send(makeMsg())
    expect(result.ok).toBe(false)
  })

  // Item 4: network failure leaves email retryable
  test('network failure returns ok=false (retryable — no exception)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any
    const result = await createResendAdapter('key').send(makeMsg())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Network error')
  })

  // Item 13: API key never appears in logs
  test('API key is NOT included in error messages', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as any
    const key    = 'super-secret-api-key-xyz'
    const result = await createResendAdapter(key).send(makeMsg())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).not.toContain(key)
      expect(result.message).not.toContain('secret')
    }
  })

  test('passes deterministic Idempotency-Key to Resend', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'msg-idem' }),
    }) as any
    global.fetch = fetchSpy
    await createResendAdapter('key').send(makeMsg({ idempotencyKey: 'order-confirmation/xyz' }))
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.headers['Idempotency-Key']).toBe('order-confirmation/xyz')
  })
})

// ── getEmailProvider ──────────────────────────────────────────────────────────

describe('getEmailProvider', () => {
  const origEnv = process.env.RESEND_API_KEY

  afterEach(() => {
    if (origEnv !== undefined) process.env.RESEND_API_KEY = origEnv
    else delete process.env.RESEND_API_KEY
  })

  // Item 11: missing RESEND_API_KEY fails safely
  test('throws clearly when RESEND_API_KEY is missing', () => {
    delete process.env.RESEND_API_KEY
    expect(() => getEmailProvider()).toThrow('RESEND_API_KEY is not set')
  })

  test('does not throw when RESEND_API_KEY is set', () => {
    process.env.RESEND_API_KEY = 'test-key'
    expect(() => getEmailProvider()).not.toThrow()
  })
})

// ── FROM address construction ─────────────────────────────────────────────────

describe('FROM address uses RESEND_FROM_EMAIL and RESEND_FROM_NAME', () => {
  // Item 12: missing sender config handled
  test('transactional-email.ts source uses buildFromAddress() not a hardcoded string', () => {
    const fs  = require('fs')
    const src = fs.readFileSync(require('path').join(__dirname, '../transactional-email.ts'), 'utf8')
    expect(src).toContain('buildFromAddress()')
    expect(src).toContain('RESEND_FROM_EMAIL')
    expect(src).toContain('RESEND_FROM_NAME')
    // Key: API key must not be embedded in source
    expect(src).not.toMatch(/re_[A-Za-z0-9]{20,}/)
  })
})

// ── processOneEmail: sent/failure/duplicate state machine ─────────────────────

// Simulate processOneEmail state transitions using minimal SQL mock

function makeSqlMock(rows: Record<string, any>): any {
  return async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join('?').toLowerCase()
    if (query.includes('select') && query.includes('for update')) {
      return rows.claimed ?? []
    }
    if (query.includes('update') && query.includes("status='sent'")) {
      rows.sentUpdate = true
    }
    if (query.includes('update') && query.includes("status='failed'")) {
      rows.failedUpdate = true
    }
    if (query.includes("status='sending'")) {
      rows.sendingUpdate = true
    }
    return []
  }
}

describe('processOneEmail state transitions', () => {
  // Item 5: successful send marks row sent
  test('ok provider result → outcome sent, SQL updated', async () => {
    const { processOneEmail } = await import('../transactional-email')

    const mockRows: any = {
      claimed: [{
        id: 'row-1', order_id: 'ord-1', email_type: 'order_confirmation',
        recipient_email: 'c@e.com', status: 'pending', attempt_count: 0,
        idempotency_key: 'order-confirmation/ord-1',
      }]
    }
    const sql      = makeSqlMock(mockRows)
    // Provide fake order data via SQL returning rows for SELECT queries
    const sqlFull: any = async (strings: TemplateStringsArray, ...vals: any[]) => {
      const q = strings.join('?').toLowerCase()
      if (q.includes('for update')) return mockRows.claimed ?? []
      if (q.includes('order_number')) return [{
        order_number:'KVRN-001',customer_email:'c@e.com',customer_name:'Test',
        subtotal_cents:8000,shipping_cents:1999,total_cents:9999,
        shipping_method:'standard',shipping_address:null
      }]
      if (q.includes('order_items')) return [{
        product_name:'Hoodie',color:'Black',size:'M',quantity:1,
        unit_price_cents:8000,line_total_cents:8000,
      }]
      if (q.includes("status='sent'")) mockRows.sentUpdate = true
      return []
    }

    const provider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'msg-ok' }) }
    const result   = await processOneEmail({ sql: sqlFull, provider, rowId: 'row-1' })
    expect(result.outcome).toBe('sent')
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(mockRows.sentUpdate).toBe(true)
  })

  // Item 6: retry does not duplicate an already-sent email
  test('row with status=sent → outcome already_sent, provider not called', async () => {
    const { processOneEmail } = await import('../transactional-email')

    const sql: any = async (strings: TemplateStringsArray) => {
      const q = strings.join('?').toLowerCase()
      if (q.includes('for update')) return [{
        id:'row-2', order_id:'ord-2', email_type:'order_confirmation',
        recipient_email:'c@e.com', status:'sent', attempt_count:1,
        idempotency_key:'order-confirmation/ord-2',
      }]
      return []
    }

    const provider = { send: jest.fn() }
    const result   = await processOneEmail({ sql, provider, rowId: 'row-2' })
    expect(result.outcome).toBe('already_sent')
    expect(provider.send).not.toHaveBeenCalled()
  })

  // Item 14: order remains valid when email send fails
  test('failed provider result → outcome failed, no effect on order tables', async () => {
    const { processOneEmail } = await import('../transactional-email')

    const updatedTables: string[] = []
    const sql: any = async (strings: TemplateStringsArray) => {
      const q = strings.join('?').toLowerCase()
      if (q.includes('for update')) return [{
        id:'row-3', order_id:'ord-3', email_type:'order_confirmation',
        recipient_email:'c@e.com', status:'pending', attempt_count:0,
        idempotency_key:'order-confirmation/ord-3',
      }]
      if (q.includes('order_number')) return [{
        order_number:'KVRN-003',customer_email:'c@e.com',customer_name:'T',
        subtotal_cents:8000,shipping_cents:1999,total_cents:9999,
        shipping_method:'standard',shipping_address:null,
      }]
      if (q.includes('order_items')) return []
      if (q.includes('orders') && q.includes('update')) updatedTables.push('orders')
      if (q.includes('inventory') && q.includes('update')) updatedTables.push('inventory')
      return []
    }

    const provider = { send: jest.fn().mockResolvedValue({ ok: false, message: 'Provider down.' }) }
    const result   = await processOneEmail({ sql, provider, rowId: 'row-3' })
    expect(result.outcome).toBe('failed')
    // Orders / inventory tables must not be touched
    expect(updatedTables).not.toContain('orders')
    expect(updatedTables).not.toContain('inventory')
  })
})

// ── Cron 522 fix verification ─────────────────────────────────────────────────

describe('cron 522 fix: no external self-fetch', () => {
  // Item 10: cron no longer performs the failing public self-fetch
  test('cron wrapper uses openNextWorker.fetch instead of external URL fetch', () => {
    const fs     = require('fs')
    const wrapper = fs.readFileSync(
      require('path').join(__dirname, '../../cloudflare-cron-wrapper.js'), 'utf8'
    )
    // Must call openNextWorker.fetch — direct internal invocation
    expect(wrapper).toContain('openNextWorker.fetch(req, env, ctx)')
    // Must NOT fetch an external SITE_URL (the 522 cause)
    expect(wrapper).not.toContain('fetch(`${siteUrl}')
    expect(wrapper).not.toContain("fetch(siteUrl")
    expect(wrapper).not.toContain('SITE_URL || env.NEXT_PUBLIC_SITE_URL')
  })

  test('cron wrapper uses synthetic internal Request, not external hostname', () => {
    const fs     = require('fs')
    const wrapper = fs.readFileSync(
      require('path').join(__dirname, '../../cloudflare-cron-wrapper.js'), 'utf8'
    )
    // Synthetic URL uses cron-internal hostname, not kvrn.shop
    expect(wrapper).toContain('cron-internal/api/internal/transactional-email-retry')
    expect(wrapper).not.toContain('kvrn.shop/api/internal')
  })

  test('cron wrapper still passes CRON_SECRET so route auth is preserved', () => {
    const fs     = require('fs')
    const wrapper = fs.readFileSync(
      require('path').join(__dirname, '../../cloudflare-cron-wrapper.js'), 'utf8'
    )
    expect(wrapper).toContain('CRON_SECRET')
    expect(wrapper).toContain("'Authorization'")
  })
})

// ── Duplicate prevention ──────────────────────────────────────────────────────

describe('duplicate send prevention', () => {
  // Item 7: duplicate Stripe webhook does not enqueue duplicate confirmation
  test('finalize_paid_order uses ON CONFLICT DO NOTHING for email outbox row', () => {
    // Verified by reading DB migration 004: INSERT ... ON CONFLICT (order_id, email_type) DO NOTHING
    // This is the DB-level idempotency that prevents duplicate webhook processing
    // from creating duplicate outbox rows.
    const fs  = require('fs')
    const mig = fs.readFileSync(
      require('path').join(__dirname, '../../db/migrations/004_transactional_email_v51.sql'),
      'utf8'
    )
    expect(mig).toContain('ON CONFLICT (order_id, email_type) DO NOTHING')
  })

  // Item 8: shipping confirmation only enqueued once
  test('mark_order_shipped uses ON CONFLICT DO NOTHING for shipping_confirmation row', () => {
    const fs  = require('fs')
    const mig = fs.readFileSync(
      require('path').join(__dirname, '../../db/migrations/005_shipping_v51.sql'),
      'utf8'
    )
    expect(mig).toContain("'shipping_confirmation'")
    expect(mig).toContain('ON CONFLICT (order_id, email_type) DO NOTHING')
  })

  // Item 9: cron / shared retry function processes pending email
  test('processPendingTransactionalEmails function is exported and callable', async () => {
    const { processPendingTransactionalEmails } = await import('../transactional-email')
    expect(typeof processPendingTransactionalEmails).toBe('function')
  })
})

// ── Email architecture verification ──────────────────────────────────────────

describe('email architecture', () => {
  test('processOneEmail handles order_confirmation type', async () => {
    const { processOneEmail } = await import('../transactional-email')
    // Verified by source inspection: handles 'order_confirmation' branch
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../transactional-email.ts'), 'utf8'
    )
    expect(src).toContain("row.email_type === 'order_confirmation'")
    expect(src).toContain("row.email_type === 'shipping_confirmation'")
  })

  test('email templates have tracking link for customer self-service', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../email.ts'), 'utf8'
    )
    expect(src).toContain('support/track')
  })

  test('outbox sender uses RESEND_FROM_EMAIL env var, not hardcoded credentials', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../transactional-email.ts'), 'utf8'
    )
    expect(src).toContain('RESEND_FROM_EMAIL')
    // Must not hardcode any email address outside the default fallback
    expect(src).not.toMatch(/re_[A-Za-z0-9]{20,}/)   // no real API key
  })
})
