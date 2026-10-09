#!/usr/bin/env node
// LOCAL-ONLY: Messaging Terms / Messaging Privacy in the CMS. Draft-only creation from the owner's October 6 text; stays 404 publicly
// (KVRN_SMS_POLICY_PUBLIC_ENABLED is NOT set on the dev server). Refuses non-localhost. Writes the scratch DB only.
const base = new URL(process.env.KVRN_E2E_BASE || 'http://localhost:3111')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) { console.error('local only'); process.exit(2) }
const h = { 'x-dev-admin-email': process.env.KVRN_E2E_ADMIN || 'dev@kvrn.test', 'content-type': 'application/json' }
let fails = 0
const ok = (c, m, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x ? '  ' + x : ''}`); if (!c) fails++ }
const api = async (method, p, body) => { const r = await fetch(new URL(p, base), { method, headers: h, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json() } catch {}; return { status: r.status, j } }
for (const id of ['messaging-terms', 'messaging-privacy']) {
  console.log(`== ${id} ==`)
  const U = `/api/admin/content/policies/${id}`
  let g = (await api('GET', U)).j?.data
  ok(!!g, 'editor can open it (blank default)', JSON.stringify(g).slice(0, 120))
  if (g && !g.exists) {
    const ld = await api('POST', `${U}/owner-draft`, { revision: 0 }); ok(ld.status === 200, 'load October 6 draft creates the draft', JSON.stringify(ld.j).slice(0, 200))
  }
  g = (await api('GET', U)).j.data
  ok(g.exists && g.hasDraft && !g.isLive, 'draft exists and is NOT live')
  const r = await fetch(new URL('/' + id, base)); ok(r.status === 404, `public /${id} is still 404 (gated + unpublished): ${r.status}`)
  const sm = await (await fetch(new URL('/sitemap.xml', base))).text(); ok(!sm.includes('/' + id), 'not in the sitemap')
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
