import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

describe('Stage 2 merged security hardening guards', () => {
  test('security migration keeps public abuse control and safe redirect constraint', () => {
    const sql = read('db/migrations/037_security_hardening.sql')
    expect(sql).toContain('public_api_rate_events')
    expect(sql).toContain('public_api_rate_allow')
    expect(sql).toContain('content_redirects_safe_paths_chk')
  })

  test('affiliate invitation bearer token stays out of the HTTP query string', () => {
    const email = read('lib/affiliate-program-email.ts')
    const client = read('app/affiliates/apply/ApplyClient.tsx')
    const route = read('app/api/affiliates/invite/route.ts')

    expect(email).toContain('/affiliates/apply#invite=')
    expect(email).not.toContain('/affiliates/apply?invite=')
    expect(client).toContain('window.location.hash')
    expect(client).toContain("history.replaceState")
    expect(client).toContain("method: 'POST'")
    expect(route).toMatch(/export\s+async\s+function\s+POST/)
    expect(route).not.toMatch(/export\s+async\s+function\s+GET/)
    expect(route).not.toContain('searchParams.get(\'token\')')
  })

  test('public bundle and recovery endpoints keep bounded request parsing', () => {
    const bundle = read('app/api/bundles/quote/route.ts')
    const recover = read('app/api/checkout/recover/route.ts')
    expect(bundle).toContain('16 * 1024')
    expect(bundle).toContain('allowPublicApiRequest')
    expect(recover).toContain('2 * 1024')
    expect(recover).toContain('allowPublicApiRequest')
  })

  test('production machine secrets reject whitespace-only values', () => {
    const auth = read('lib/affiliate-auth.ts')
    const application = read('lib/affiliate-application.ts')
    const publicRate = read('lib/public-api-rate-limit.ts')
    const cron = read('lib/internal-cron-auth.ts')

    expect(auth).toContain('value.trim().length >= 32')
    expect(application).toContain('value.trim().length >= 32')
    expect(publicRate).toContain('p.trim().length >= 32')
    expect(cron).toContain('secret.trim().length < 32')
  })

  test('media upload rejects excessive declared sizes before arrayBuffer conversion', () => {
    const media = read('app/api/admin/media/route.ts')
    const sizeCheck = media.indexOf('file.size')
    const arrayBuffer = media.indexOf('arrayBuffer()')
    expect(sizeCheck).toBeGreaterThan(-1)
    expect(arrayBuffer).toBeGreaterThan(-1)
    expect(sizeCheck).toBeLessThan(arrayBuffer)
  })
})
