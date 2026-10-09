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
      if (!/requireAdmin\(/.test(body)) {
        // Only private owner-scoped wrappers already present in this module may
        // authenticate a handler. A regex match alone is insufficient: the exact
        // called helper must independently reach requireAdmin(req).
        const delegated = /const auth=await (owner|authorized)\(req\)/.exec(body)
        expect(delegated).not.toBeNull()
        const helper = delegated![1]
        const definition = src.indexOf(`async function ${helper}(req:NextRequest)`)
        expect(definition).toBeGreaterThan(-1)
        const helperBody = src.slice(definition, src.indexOf('\n}', definition) + 2)
        expect(helperBody).toMatch(/await requireAdmin\(req\)/)
        // Authenticate before the handler can access request bodies or data.
        expect(body.indexOf(delegated![0])).toBeLessThan(
          Math.min(...['readAdminMutationJson(req', 'sql`', 'previewApprovedEmailCampaign(', 'recordOwnerApproval(']
            .map(k => { const i = body.indexOf(k); return i < 0 ? Infinity : i }))
        )
      }
    }
  })
})
