import { isPushoverConfigured, sendPushoverNotification } from '../pushover'

describe('Pushover transport', () => {
  test('requires both runtime secrets', () => {
    expect(isPushoverConfigured({} as any)).toBe(false)
    expect(isPushoverConfigured({ PUSHOVER_USER_KEY: 'u' } as any)).toBe(false)
    expect(isPushoverConfigured({ PUSHOVER_API_TOKEN: 't' } as any)).toBe(false)
    expect(isPushoverConfigured({ PUSHOVER_USER_KEY: 'u', PUSHOVER_API_TOKEN: 't' } as any)).toBe(true)
  })

  test('posts form data and treats status=1 as sent', async () => {
    const fetchImpl = jest.fn(async (_url: any, init: any) => {
      const body = new URLSearchParams(init.body)
      expect(body.get('token')).toBe('app-token')
      expect(body.get('user')).toBe('user-key')
      expect(body.get('title')).toBe('KVRN TEST')
      expect(body.get('message')).toBe('hello')
      expect(body.get('priority')).toBe('1')
      return new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any

    const r = await sendPushoverNotification(
      { title: 'KVRN TEST', message: 'hello', priority: 1 },
      { env: { PUSHOVER_USER_KEY: 'user-key', PUSHOVER_API_TOKEN: 'app-token' } as any, fetchImpl },
    )
    expect(r).toEqual({ outcome: 'sent' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('fails open on provider/network failure and never throws', async () => {
    const env = { PUSHOVER_USER_KEY: 'u', PUSHOVER_API_TOKEN: 't' } as any
    const http = await sendPushoverNotification(
      { title: 'x', message: 'y' },
      { env, fetchImpl: jest.fn(async () => new Response('no', { status: 503 })) as any },
    )
    expect(http).toEqual({ outcome: 'failed', reason: 'http_503' })

    const network = await sendPushoverNotification(
      { title: 'x', message: 'y' },
      { env, fetchImpl: jest.fn(async () => { throw new Error('offline') }) as any },
    )
    expect(network).toEqual({ outcome: 'failed', reason: 'network_error' })
  })

  const ENV = { PUSHOVER_USER_KEY: 'u', PUSHOVER_API_TOKEN: 't' } as any

  test('uses the official endpoint and form encoding', async () => {
    let seen: any
    const fetchImpl = jest.fn(async (url: any, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ status: 1 })) }) as any
    await sendPushoverNotification({ title: 'a', message: 'b', url: 'https://kvrn.shop/admin', urlTitle: 'Open' }, { env: ENV, fetchImpl })
    expect(seen.url).toBe('https://api.pushover.net/1/messages.json')
    expect(seen.init.method).toBe('POST')
    expect(seen.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(seen.init.body)
    expect(body.get('url')).toBe('https://kvrn.shop/admin')
    expect(body.get('url_title')).toBe('Open')
  })

  test('is bounded in time: a hung provider is aborted and reported as a timeout', async () => {
    const fetchImpl = jest.fn((_u: any, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => { const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e) })
    })) as any
    const t0 = Date.now()
    const r = await sendPushoverNotification({ title: 'x', message: 'y' }, { env: ENV, fetchImpl, timeoutMs: 30 })
    expect(r).toEqual({ outcome: 'failed', reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('the default timeout is short (2s) so a hook can never hold a request for long', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'pushover.ts'), 'utf8')
    expect(src).toMatch(/DEFAULT_TIMEOUT_MS\s*=\s*2000/)
  })

  test('no retry: exactly one HTTP attempt per call, even on failure', async () => {
    const fetchImpl = jest.fn(async () => new Response('x', { status: 500 })) as any
    await sendPushoverNotification({ title: 'x', message: 'y' }, { env: ENV, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('provider status 0 is a failure; unconfigured makes no request; oversize fields are clamped to the API limits', async () => {
    const rej = await sendPushoverNotification({ title: 'x', message: 'y' },
      { env: ENV, fetchImpl: jest.fn(async () => new Response(JSON.stringify({ status: 0, errors: ['bad token'] }))) as any })
    expect(rej).toEqual({ outcome: 'failed', reason: 'provider_rejected' })       // provider error text (may echo input) is never returned

    const f = jest.fn()
    expect(await sendPushoverNotification({ title: 'x', message: 'y' }, { env: {} as any, fetchImpl: f as any }))
      .toEqual({ outcome: 'skipped', reason: 'not_configured' })
    expect(f).not.toHaveBeenCalled()

    let body: URLSearchParams | undefined
    const fetchImpl = jest.fn(async (_u: any, init: any) => { body = new URLSearchParams(init.body); return new Response(JSON.stringify({ status: 1 })) }) as any
    await sendPushoverNotification({ title: 'T'.repeat(900), message: 'M'.repeat(5000), url: 'https://x.test/' + 'u'.repeat(2000) }, { env: ENV, fetchImpl })
    expect(body!.get('title')!.length).toBeLessThanOrEqual(250)
    expect(body!.get('message')!.length).toBeLessThanOrEqual(1024)
    expect(body!.get('url')!.length).toBeLessThanOrEqual(512)
  })

  test('an empty title or message is refused locally, without a request', async () => {
    const f = jest.fn()
    expect(await sendPushoverNotification({ title: '  ', message: 'y' }, { env: ENV, fetchImpl: f as any })).toEqual({ outcome: 'failed', reason: 'invalid_message' })
    expect(f).not.toHaveBeenCalled()
  })
})
