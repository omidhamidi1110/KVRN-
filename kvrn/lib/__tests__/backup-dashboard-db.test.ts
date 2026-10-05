// lib/__tests__/backup-dashboard-db.test.ts
//
// The backup dashboard against a REAL local PostgreSQL (admin_audit_logs as created by the
// repo's own migrations). Skips unless TEST_DATABASE_URL points at a LOCAL server (helpers/fi-pg.ts
// refuses anything else, so production Neon can never be reached from here).

import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { createBackupService, BACKUP_ACTION, VERIFY_ACTION, DRILL_ACTION, BACKUP_RESOURCE } from '../backup-records'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__BKD_DENY) return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    return { identity: { email: 'owner@kvrn.test' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__BKD_SQL } }))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: backup dashboard DB tests skipped — TEST_DATABASE_URL is not a local server.'
                   : 'NOTE: backup dashboard real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => { expect(true).toBe(true) })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const iso = (daysAgo: number, extraMs = 0) => new Date(Date.now() - daysAgo * 86_400_000 - extraMs).toISOString()
const SHA = 'b'.repeat(64)

beforeAll(async () => {
  if (!HAVE_DB) return
  try { F = await createFiDb('kvrn_backups'); (global as any).__BKD_SQL = F.sql } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__BKD_DENY = false })
beforeEach(async () => { if (HAVE_DB && !pgFail) await q('DELETE FROM admin_audit_logs') })   // test-database housekeeping only

const svc = () => createBackupService(F.sql)
const route = (p: string) => require(`../../app/api/admin/backups${p}/route`)
const post = (p: string, body: unknown) =>
  route(p).POST(new NextRequest('http://localhost/api/admin/backups' + p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const get = () => route('').GET(new NextRequest('http://localhost/api/admin/backups'))

describeDB('backup records in the real admin_audit_logs', () => {
  test('empty table: unknown, with no records', async () => {
    needDb()
    const d = await (await get()).json()
    expect(d.backups).toEqual([]); expect(d.drills).toEqual([])
    expect(d.readiness.overall.state).toBe('unknown')
    expect(d.readiness.backup).toMatchObject({ state: 'unknown', at: null, ageDays: null })
  })

  test('record -> verify -> drill through the real routes; every write is a new audit row', async () => {
    needDb()
    const c = await post('', { backupAt: iso(1), type: 'logical', reference: 'kvrn-prod.dump', sizeBytes: 5_000_000, sha256: SHA, notes: 'weekly' })
    expect(c.status).toBe(201)
    const { id } = await c.json()
    const [stored] = await q(`SELECT id::text, actor_email, action, resource, resource_id, payload FROM admin_audit_logs WHERE id = $1`, [id])
    expect(stored).toMatchObject({ id, actor_email: 'owner@kvrn.test', action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id })
    expect(stored.payload).toMatchObject({ v: 1, type: 'logical', reference: 'kvrn-prod.dump', sizeBytes: 5_000_000, sha256: SHA })
    const original = JSON.stringify(stored)

    expect((await post('/verify', { backupId: id, verifiedAt: iso(0, 1000), result: 'passed', notes: 'restored to scratch' })).status).toBe(201)
    expect((await post('/drills', { drillAt: iso(0, 1000), result: 'passed', runbookRef: '97c761a' })).status).toBe(201)

    const rows = await q(`SELECT id::text, action FROM admin_audit_logs ORDER BY created_at`)
    expect(rows.map((r: any) => r.action)).toEqual([BACKUP_ACTION, VERIFY_ACTION, DRILL_ACTION])
    const [again] = await q(`SELECT id::text, actor_email, action, resource, resource_id, payload FROM admin_audit_logs WHERE id = $1`, [id])
    expect(JSON.stringify(again)).toBe(original)                                  // the backup row was never rewritten

    const d = await (await get()).json()
    expect(d.backups).toHaveLength(1)
    expect(d.backups[0]).toMatchObject({ id, reference: 'kvrn-prod.dump', sizeBytes: 5_000_000, sha256: SHA, recordedBy: 'owner@kvrn.test' })
    expect(d.backups[0].verification.state).toBe('verified')
    expect(d.readiness.overall.state).toBe('verified')
  })

  test('optional fields stay absent (unknown), and size 0 is kept as a real zero', async () => {
    needDb()
    const a = await (await post('', { backupAt: iso(2), type: 'provider_snapshot' })).json()
    const b = await (await post('', { backupAt: iso(3), type: 'other', sizeBytes: 0 })).json()
    const d = await (await get()).json()
    const byId = Object.fromEntries(d.backups.map((x: any) => [x.id, x]))
    expect(byId[a.id]).toMatchObject({ reference: null, sizeBytes: null, sha256: null, notes: null })
    expect(byId[b.id].sizeBytes).toBe(0)
    const [row] = await q(`SELECT payload FROM admin_audit_logs WHERE id = $1`, [a.id])
    expect(Object.keys(row.payload).sort()).toEqual(['backupAt', 'type', 'v'])
  })

  test('verification must reference a recorded backup; legacy/unrelated audit rows are not backups', async () => {
    needDb()
    // rows the rest of the admin writes: they must be invisible to, and un-verifiable by, this feature
    const legacy = (await q(`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
                             VALUES ('x@kvrn.test','create','provider_usage_snapshot', gen_random_uuid()::text,'{"provider":"Neon","apiKey":"sk_live_SECRET"}')
                             RETURNING id::text`))[0].id
    const lookalike = randomUUID()
    await q(`INSERT INTO admin_audit_logs (id, actor_email, action, resource, resource_id, payload)
             VALUES ($1::uuid,'x@kvrn.test','backup_recorded','orders',$1::text,'{"v":1,"backupAt":"2026-10-01T00:00:00Z","type":"logical"}')`, [lookalike])
    const broken = randomUUID()
    await q(`INSERT INTO admin_audit_logs (id, actor_email, action, resource, resource_id, payload)
             VALUES ($1::uuid,'x@kvrn.test','backup_recorded','backup_record',$1::text,'{"v":1,"backupAt":"not a date","type":"logical"}')`, [broken])

    for (const id of [legacy, lookalike, broken, randomUUID()]) {
      const res = await post('/verify', { backupId: id, verifiedAt: iso(0, 1000), result: 'passed' })
      expect(res.status).toBe(404)
    }
    expect((await q(`SELECT count(*)::int AS n FROM admin_audit_logs WHERE action = 'backup_restore_verified'`))[0].n).toBe(0)

    const d = await (await get()).json()
    expect(d.backups).toEqual([])                                                // none of the three is a backup
    expect(d.ignored.backups).toBe(1)                                            // the malformed one is counted, not shown
    expect(JSON.stringify(d)).not.toMatch(/SECRET|provider_usage_snapshot|apiKey|not a date/)
  })

  test('a verification pointing at a backup that is not in the table is ignored if it is ever present', async () => {
    needDb()
    const ghost = randomUUID()
    await q(`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
             VALUES ('x@kvrn.test','backup_restore_verified','backup_record',$1,$2::jsonb)`,
            [ghost, JSON.stringify({ v: 1, backupId: ghost, verifiedAt: iso(1), result: 'passed' })])
    const d = await svc().getDashboard()
    expect(d.readiness.restoreVerification.state).toBe('unknown')
    expect(d.ignored.verifications).toBe(1)
  })

  test('a failed re-test after a pass is shown as failed; both events are kept', async () => {
    needDb()
    const { id } = await svc().recordBackup({ backupAt: iso(3), type: 'logical' }, 'a@kvrn.test')
    await svc().recordVerification({ backupId: id, verifiedAt: iso(2), result: 'passed' }, 'a@kvrn.test')
    await svc().recordVerification({ backupId: id, verifiedAt: iso(1), result: 'failed', notes: 'schema mismatch' }, 'b@kvrn.test')
    const d = await svc().getDashboard()
    expect(d.backups[0].verification).toMatchObject({ state: 'failed', testsRecorded: 2 })
    expect(d.readiness.overall.state).toBe('failed')
    expect((await q(`SELECT count(*)::int AS n FROM admin_audit_logs WHERE resource_id = $1`, [id]))[0].n).toBe(3)
  })

  test('REVISION 1: a newer pass on an OLDER backup never makes overall VERIFIED (real rows)', async () => {
    needDb()
    const b = await svc().recordBackup({ backupAt: iso(3), type: 'logical', reference: 'older.dump' }, 'a@kvrn.test')
    const a = await svc().recordBackup({ backupAt: iso(1), type: 'logical', reference: 'newest.dump' }, 'a@kvrn.test')
    await svc().recordDrill({ drillAt: iso(0, 5000), result: 'passed' }, 'a@kvrn.test')
    // the newest backup's own test FAILED; the older backup then passes LATER
    await svc().recordVerification({ backupId: a.id, verifiedAt: iso(0.5), result: 'failed' }, 'a@kvrn.test')
    await svc().recordVerification({ backupId: b.id, verifiedAt: iso(0, 2000), result: 'passed' }, 'a@kvrn.test')
    let d = await (await get()).json()
    expect(d.backups[0]).toMatchObject({ id: a.id })
    expect(d.backups[0].verification.state).toBe('failed')
    expect(d.readiness.restoreVerification).toMatchObject({ state: 'current', backupId: b.id })
    expect(d.readiness.overall.state).toBe('failed')
    // once the newest backup is re-tested and passes, overall becomes VERIFIED
    await svc().recordVerification({ backupId: a.id, verifiedAt: iso(0, 1000), result: 'passed' }, 'a@kvrn.test')
    d = await (await get()).json()
    expect(d.backups[0].verification.state).toBe('verified')
    expect(d.readiness.overall.state).toBe('verified')
    // and a newest backup with no test of its own is only RECORDED, whatever the older one did
    await svc().recordBackup({ backupAt: iso(0, 500), type: 'logical', reference: 'newer-still.dump' }, 'a@kvrn.test')
    d = await (await get()).json()
    expect(d.backups[0].verification.state).toBe('not_verified')
    expect(d.readiness.overall.state).toBe('recorded')
  })

  test('stale backup recorded now is stale; boundary uses the restore point time', async () => {
    needDb()
    await svc().recordBackup({ backupAt: iso(8), type: 'logical' }, 'a@kvrn.test')
    const d = await (await get()).json()
    expect(d.readiness.backup.state).toBe('stale'); expect(d.readiness.overall.state).toBe('stale')
  })

  test('history is bounded to 25 rows even with many records', async () => {
    needDb()
    await q(`INSERT INTO admin_audit_logs (id, actor_email, action, resource, resource_id, payload)
             SELECT g.id, 'bulk@kvrn.test', 'backup_recorded', 'backup_record', g.id::text,
                    jsonb_build_object('v',1,'backupAt',to_char(now() - (n || ' hours')::interval,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','logical')
             FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1,60) n) g`)
    const d = await (await get()).json()
    expect(d.backups).toHaveLength(25)
    expect(d.backups[0].backupAt > d.backups[24].backupAt).toBe(true)             // newest first
  })

  test('401 without admin: nothing is written or read', async () => {
    needDb()
    ;(global as any).__BKD_DENY = true
    const spy = jest.spyOn(F.db, 'query')
    expect((await get()).status).toBe(401)
    expect((await post('', { backupAt: iso(1), type: 'logical' })).status).toBe(401)
    expect((await post('/verify', { backupId: randomUUID(), verifiedAt: iso(1), result: 'passed' })).status).toBe(401)
    expect((await post('/drills', { drillAt: iso(1), result: 'passed' })).status).toBe(401)
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore()
    expect((await q(`SELECT count(*)::int AS n FROM admin_audit_logs`))[0].n).toBe(0)
  })

  test('the response carries no ip address, no unrelated payload and no env values', async () => {
    needDb()
    await q(`INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload, ip_address)
             VALUES ('x@kvrn.test','refund','orders','o1','{"email":"customer@example.com"}','203.0.113.5')`)
    await post('', { backupAt: iso(1), type: 'logical' })
    const text = JSON.stringify(await (await get()).json())
    expect(text).not.toMatch(/customer@example|203\.0\.113|ip_address|DATABASE_URL|payload/)
  })
})
