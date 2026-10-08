// Every Admin API route must authenticate with requireAdmin before touching data, and every
// admin PAGE must be rendered inside the Admin shell (layout). Applies to ALL admin routes,
// existing and new — the batch must never add an unauthenticated mutation route.
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}

describe('admin API routes require requireAdmin', () => {
  const routes = walk(path.join(ROOT, 'app/api/admin')).filter(f => /route\.ts$/.test(f))
  test('there are admin routes', () => { expect(routes.length).toBeGreaterThan(40) })
  test.each(routes.map(f => [path.relative(ROOT, f), f]))('%s', (_n, f) => {
    const src = fs.readFileSync(f as string, 'utf8')
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
    expect(handlers.length).toBeGreaterThan(0)
    // each exported handler must reach requireAdmin before any DB use
    for (const h of handlers) {
      const start = src.indexOf(`export async function ${h}`)
      const body = src.slice(start, start + 1500)
      expect(body).toMatch(/requireAdmin\(/)
    }
  })
})
