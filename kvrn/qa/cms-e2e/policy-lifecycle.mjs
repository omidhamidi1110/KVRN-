#!/usr/bin/env node
// LOCAL-ONLY end-to-end check of the policy lifecycle against a dev server whose database is a scratch copy:
//   load owner's Oct 6 draft -> (not public) -> publish -> edit -> publish -> rollback -> seed rollback refused -> stale save refused.
// Refuses anything that is not localhost. Uses the dev admin header (honoured only when NODE_ENV != production).
//   KVRN_E2E_BASE=http://localhost:3111 KVRN_E2E_ADMIN=dev@kvrn.test node qa/cms-e2e/policy-lifecycle.mjs
// NOTE: it PUBLISHES in the scratch database. Never point it at a real database.
const base = new URL(process.env.KVRN_E2E_BASE || 'http://localhost:3111')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) { console.error('local only'); process.exit(2) }
const admin = process.env.KVRN_E2E_ADMIN || 'dev@kvrn.test'
const ID = process.env.KVRN_E2E_POLICY || 'privacy', PATH_ = `/${ID}`
const MARK = `E2E-MARKER-${Date.now()}`
let fails = 0
const ok = (c, m, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && extra ? '  ' + extra : ''}`); if (!c) fails++ }
const api = async (method, p, body) => {
  const r = await fetch(new URL(p, base), { method, headers: { 'x-dev-admin-email': admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, j }
}
const page = async () => (await fetch(new URL(PATH_, base))).text()
const get = async () => (await api('GET', `/api/admin/content/policies/${ID}`)).j.data
const U = `/api/admin/content/policies/${ID}`

let cur = await get()
ok(!!cur, `GET ${ID}`)

// 1. owner draft -> draft only
const ld = await api('POST', `${U}/owner-draft`, { revision: cur.revision })
ok(ld.status === 200, 'load October 6 draft', JSON.stringify(ld.j).slice(0, 200)); cur = await get()
ok(cur.hasDraft && !cur.placeholderSeed, 'draft present and no longer the placeholder')

// 2. publish it (a human publish after review)
const p1 = await api('POST', U, { action: 'publish', revision: cur.revision })
ok(p1.status === 200, 'publish owner draft', JSON.stringify(p1.j).slice(0, 200)); cur = await get()
const v1 = cur.publishedVersion
const html1 = await page()
ok(html1.length > 5000 && !html1.includes(MARK), 'CMS-served policy renders')

// 3. edit with a marker paragraph, save, not public until published
const snap = JSON.parse(JSON.stringify(cur.snapshot)); snap.body.blocks.push({ t: 'p', c: [{ t: 'text', text: MARK }] })
const sv = await api('PUT', U, { snapshot: snap, revision: cur.revision })
ok(sv.status === 200, 'save draft'); ok(!(await page()).includes(MARK), 'draft is NOT public')
const stale = await api('PUT', U, { snapshot: snap, revision: 1 }); ok(stale.status === 409, `stale revision rejected (${stale.status})`)
cur = await get()
const p2 = await api('POST', U, { action: 'publish', revision: cur.revision }); ok(p2.status === 200, 'publish edit')
ok((await page()).includes(MARK), 'published edit is public')

// 4. rollback restores the earlier published text
cur = await get()
const rb = await api('POST', U, { action: 'rollback', versionNo: v1, revision: cur.revision }); ok(rb.status === 200, `rollback to v${v1}`, JSON.stringify(rb.j).slice(0, 200))
ok(!(await page()).includes(MARK), 'after rollback the marker is gone')

// 5. rolling back to the migration placeholder (v1) is refused
cur = await get()
const bad = await api('POST', U, { action: 'rollback', versionNo: 1, revision: cur.revision })
ok(bad.status === 409 && bad.j?.code === 'seed_copy', `rollback to the placeholder refused (${bad.status} ${bad.j?.code})`)

// 6. legal pages cannot be unpublished
const un = await api('POST', U, { action: 'unpublish', revision: cur.revision }); ok(un.status === 403, `unpublish forbidden (${un.status})`)

const vs = (await api('GET', `${U}/versions`)).j?.data ?? []
ok(vs.length >= 4, `history has ${vs.length} versions`)
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0)
