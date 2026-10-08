import { publicClientAddress, publicRateLimitConfigured } from '../public-api-rate-limit'

describe('public API rate-limit security rules', () => {
  test('production requires a >=32-character secret', () => {
    expect(publicRateLimitConfigured({ NODE_ENV: 'production' })).toBe(false)
    expect(publicRateLimitConfigured({ NODE_ENV: 'production', PUBLIC_API_RATE_PEPPER: 'short' })).toBe(false)
    expect(publicRateLimitConfigured({ NODE_ENV: 'production', PUBLIC_API_RATE_PEPPER: ' '.repeat(32) })).toBe(false)
    expect(publicRateLimitConfigured({ NODE_ENV: 'production', PUBLIC_API_RATE_PEPPER: 'x'.repeat(32) })).toBe(true)
    expect(publicRateLimitConfigured({ NODE_ENV: 'test' })).toBe(true)
  })

  test('production trusts CF-Connecting-IP and never X-Forwarded-For', () => {
    expect(publicClientAddress(new Headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.2' }), { NODE_ENV: 'production', PUBLIC_API_RATE_PEPPER: 'x'.repeat(32) }))
      .toBe('203.0.113.9')
    expect(() => publicClientAddress(new Headers({ 'x-forwarded-for': '198.51.100.2' }), { NODE_ENV: 'production', PUBLIC_API_RATE_PEPPER: 'x'.repeat(32) }))
      .toThrow(/Cloudflare client address/i)
  })

  test('local/test may use X-Forwarded-For for fixtures', () => {
    expect(publicClientAddress(new Headers({ 'x-forwarded-for': '198.51.100.2, 198.51.100.3' }), { NODE_ENV: 'test' }))
      .toBe('198.51.100.2')
  })
})
