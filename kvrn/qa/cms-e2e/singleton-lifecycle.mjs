#!/usr/bin/env node
// LOCAL-ONLY lifecycle check for the singleton content kinds (announcement, navigation, footer, about, contact):
//   GET -> edit a marker -> save draft (not public) -> stale save refused -> publish (public) -> edit+publish -> rollback.
// Refuses anything that is not localhost. PUBLISHES in the scratch database - never point it at a real database.
//   KVRN_E2E_BASE=http://localhost:3111 node qa/cms-e2e/singleton-lifecycle.mjs [kind ...]
const base = new URL(process.env.KVRN_E2E_BASE || 'http://localhost:3111')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) { console.error('local only'); process.exit(2) }
const admin = process.env.KVRN_E2E_ADMIN || 'dev@kvrn.test'
const kinds = process.argv.slice(2).length ? process.argv.slice(2) : ['announcement', 'navigation', 'footer', 'about', 'contact']
const RUN = Date.now().toString(36)
let MARK = ''
let fails = 0
const ok = (c, m, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x ? '  ' + x : ''}`); if (!c) fails++ }
const api = async (method, p, body) => {
  const r = await fetch(new URL(p, base), { method, headers: { 'x-dev-admin-email': admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, j }
}
const html = async p => (await fetch(new URL(p, base))).text()
// where each kind shows publicly + the field edited with a marker
// (specs close over the module-level MARK, which is reassigned per kind)
const SPEC = {
  announcement: { page: '/', edit: s => { s.enabled = true; s.startsAt = null; s.endsAt = null; s.messages = [{ id: 'e2e', text: `Free shipping ${MARK}` }] } },
  navigation:   { page: '/', edit: s => { s.desktop[0].label = `Shop${MARK}` } },
  footer:       { page: '/', edit: s => { s.copyrightHolder = `KVRN ${MARK}` } },
  about:        { page: '/about', edit: s => { s.heroTitle = `About ${MARK}` } },
  contact:      { page: '/contact', edit: s => { s.heroTitle = `Contact ${MARK}` } },
}
for (const kind of kinds) {
  console.log(`\n== ${kind} ==`)
  MARK = `E2E${kind.slice(0, 3)}${RUN}`   // per-kind marker: earlier kinds stay published on the same page
  const spec = SPEC[kind]; if (!spec) { ok(false, `no spec for ${kind}`); continue }
  const U = `/api/admin/content/${kind}/main`
  let g = await api('GET', U); const cur0 = g.j?.data
  ok(g.status === 200 && !!cur0, `GET ${kind}`, JSON.stringify(g.j).slice(0, 200)); if (!cur0) continue
  const baseSnap = () => JSON.parse(JSON.stringify(cur0.snapshot))
  let snap = baseSnap(); spec.edit(snap)
  const sv = await api('PUT', U, { snapshot: snap, revision: cur0.revision })
  ok(sv.status === 200, 'save draft', JSON.stringify(sv.j).slice(0, 300))
  ok(!(await html(spec.page)).includes(MARK), 'draft is NOT public')
  const stale = await api('PUT', U, { snapshot: snap, revision: 1 })
  ok(stale.status === 409, `stale revision refused (${stale.status})`)
  let cur = (await api('GET', U)).j.data
  const p1 = await api('POST', U, { action: 'publish', revision: cur.revision })
  ok(p1.status === 200, 'publish', JSON.stringify(p1.j).slice(0, 300))
  cur = (await api('GET', U)).j.data
  const v1 = cur.publishedVersion
  const h = await html(spec.page)
  ok(h.includes(MARK), 'published edit is public', `(page ${spec.page})`)
  // second edit then rollback to v1 => previous marker stays, newer one goes
  const M2 = MARK + 'B'
  snap = JSON.parse(JSON.stringify(cur.snapshot));   const text = JSON.stringify(snap).replace(MARK, M2)
  const sv2 = await api('PUT', U, { snapshot: JSON.parse(text), revision: cur.revision }); ok(sv2.status === 200, 'save 2nd edit')
  cur = (await api('GET', U)).j.data
  const p2 = await api('POST', U, { action: 'publish', revision: cur.revision }); ok(p2.status === 200, 'publish 2nd edit')
  ok((await html(spec.page)).includes(M2), '2nd edit public')
  cur = (await api('GET', U)).j.data
  const rb = await api('POST', U, { action: 'rollback', versionNo: v1, revision: cur.revision }); ok(rb.status === 200, `rollback to v${v1}`, JSON.stringify(rb.j).slice(0, 300))
  const h3 = await html(spec.page)
  ok(h3.includes(MARK) && !h3.includes(M2), 'after rollback the first edit is public and the second is gone')
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
