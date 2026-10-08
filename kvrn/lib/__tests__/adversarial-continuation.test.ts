import { execFileSync } from 'child_process'
import { join } from 'path'

describe('Merged AI OS + Task 6 adversarial audit regression', () => {
  test('policy reads, Chief governance, and media audit boundaries cannot silently regress', () => {
    const result = execFileSync(process.execPath, [join(process.cwd(), 'scripts/verify-adversarial-continuation.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result).toContain('PASS: 15 adversarial continuation assertions')
  })
})
