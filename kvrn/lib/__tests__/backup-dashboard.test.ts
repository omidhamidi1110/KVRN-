// lib/__tests__/backup-dashboard.test.ts
//
// Backup management dashboard: validation, association, append-only behaviour, readiness/staleness
// rules, response hygiene and the admin routes. Everything here runs WITHOUT a database: the pure
// helpers are tested directly, and the service/routes run against a tiny in-memory stand-in for
// admin_audit_logs. The real-PostgreSQL checks are in backup-dashboard-db.test.ts.

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import {
  parseInstant, validateReference, validateNotes, validateSizeBytes, validateSha256, looksSecret,
  validateBackupInput, validateVerificationInput, validateDrillInput, parseJsonBody,
  parseBackupPayload, assembleBackupData, computeReadiness, buildDashboard, isStale, ageDays,
  createBackupService, STALENESS_DAYS, LIMITS, OVERALL_LABEL, BACKUP_LABEL, VERIFICATION_LABEL,
  BACKUP_ACTION, VERIFY_ACTION, DRILL_ACTION, BACKUP_RESOURCE, DRILL_RESOURCE,
  type AuditRow, type Assembled,
} from '../backup-records'

// ── route mocks ──────────────────────────────────────────────────────────────
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    const deny = (global as any).__BK_DENY
    if (deny) return { identity: null, error: new Response(JSON.stringify({ error: deny === 403 ? 'Forbidden' : 'Unauthorized' }), { status: deny }) }
    return { identity: { email: 'owner@kvrn.test' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__BK_SQL } }))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const code = (p: string) => read(p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ── an in-memory admin_audit_logs, answering exactly the statements the service issues ──
interface FakeRow extends AuditRow { ip_address?: string | null }
function makeFake(seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed]
  const statements: string[] = []
  let tick = Date.UTC(2026, 9, 1)
  const fake: any = {
    rows, statements,
    query: async (text: string, params: unknown[] = []) => {
      statements.push(text.replace(/\s+/g, ' ').trim())
      if (/^\s*INSERT INTO admin_audit_logs/i.test(text)) {
        rows.push({ id: params[0], actor_email: params[1], action: params[2], resource: params[3], resource_id: params[4],
                    payload: JSON.parse(params[5] as string), created_at: new Date(tick += 1000) })
        return []
      }
      if (/WHERE action = \$1 AND resource = \$2/.test(text)) {
        return rows.filter(r => r.action === params[0] && r.resource === params[1])
          .sort((a, b) => +new Date(b.created_at as any) - +new Date(a.created_at as any)).slice(0, params[2] as number)
          .map(({ ip_address: _ip, ...r }) => r)
      }
      if (/WHERE id = \$1::uuid AND action = \$2 AND resource = \$3/.test(text)) {
        return rows.filter(r => r.id === params[0] && r.action === params[1] && r.resource === params[2]).slice(0, 1)
          .map(({ ip_address: _ip, ...r }) => r)
      }
      throw new Error('unexpected statement: ' + text)
    },
  }
  const tag: any = () => { throw new Error('tagged-template SQL is not used by the backup service') }
  return Object.assign(tag, fake)
}

const NOW = new Date('2026-10-04T12:00:00.000Z')
const iso = (daysAgo: number, extraMs = 0) => new Date(NOW.getTime() - daysAgo * 86_400_000 - extraMs).toISOString()
const SHA = 'a'.repeat(64)

const backupPayload = (daysAgo: number, extra: object = {}) => ({ v: 1, backupAt: iso(daysAgo), type: 'logical', ...extra })
const auditRow = (o: Partial<AuditRow> & { action: string; resource: string }, n = 0): AuditRow => ({
  id: randomUUID(), actor_email: 'owner@kvrn.test', resource_id: null, payload: {}, created_at: new Date(NOW.getTime() - n * 1000), ...o,
})
const mkBackup = (daysAgo: number, extra: object = {}, n = 0): AuditRow => {
  const id = randomUUID()
  return auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id, payload: backupPayload(daysAgo, extra) }, n)
}
const mkVerify = (backup: AuditRow, daysAgo: number, result = 'passed', n = 0): AuditRow =>
  auditRow({ action: VERIFY_ACTION, resource: BACKUP_RESOURCE, resource_id: backup.id as string,
             payload: { v: 1, backupId: backup.id, verifiedAt: iso(daysAgo), result } }, n)
const mkDrill = (daysAgo: number, result = 'passed', n = 0): AuditRow => {
  const id = randomUUID()
  return auditRow({ id, action: DRILL_ACTION, resource: DRILL_RESOURCE, resource_id: id, payload: { v: 1, drillAt: iso(daysAgo), result } }, n)
}
const assemble = (b: AuditRow[] = [], v: AuditRow[] = [], d: AuditRow[] = []) => assembleBackupData(b, v, d)

afterEach(() => { (global as any).__BK_DENY = 0 })

// ═════════════════════════════════════════════════════════════════════════════
// 1. VALIDATION
// ═════════════════════════════════════════════════════════════════════════════
describe('timestamps', () => {
  test.each([
    '2026-10-04T08:30:00Z', '2026-10-04T08:30Z', '2026-10-04T08:30:00.123Z', '2026-10-04T01:30:00-07:00', '2026-10-04T14:00:00+05:30',
  ])('accepts %s', s => { expect(parseInstant(s, 'backupAt', NOW).ok).toBe(true) })
  test('normalises to UTC', () => {
    expect(parseInstant('2026-10-04T01:30:00-07:00', 'x', NOW)).toEqual({ ok: true, value: '2026-10-04T08:30:00.000Z' })
  })
  test.each([
    ['empty', ''], ['no zone (ambiguous local time)', '2026-10-04T08:30:00'], ['date only', '2026-10-04'],
    ['space separator', '2026-10-04 08:30:00Z'], ['impossible day', '2026-02-31T00:00:00Z'], ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-10-04T24:00:00Z'], ['minute 60', '2026-10-04T08:60:00Z'], ['garbage', 'yesterday'],
    ['a number', 1759579800000], ['null', null], ['an object', {}], ['implausibly old', '1999-12-31T00:00:00Z'],
    ['in the future', '2026-10-04T12:06:00Z'], ['far future', '2099-01-01T00:00:00Z'],
  ])('rejects %s', (_n, v) => { expect(parseInstant(v, 'backupAt', NOW).ok).toBe(false) })
  test('a few minutes of clock skew is tolerated, not hours', () => {
    expect(parseInstant('2026-10-04T12:04:00Z', 'x', NOW).ok).toBe(true)
    expect(parseInstant('2026-10-04T12:05:01Z', 'x', NOW).ok).toBe(false)
  })
  test('the error names the field and never echoes the input', () => {
    const r = parseInstant('secret-looking-value', 'backupAt', NOW)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('backupAt')
    expect(JSON.stringify(r)).not.toContain('secret-looking-value')
  })
})

describe('backup record input', () => {
  const ok = (o: object) => validateBackupInput({ backupAt: iso(1), type: 'logical', ...o }, NOW)
  test('minimal record: only time and type are required', () => {
    const r = ok({}); expect(r.ok).toBe(true)
    expect((r as any).value).toEqual({ backupAt: iso(1), type: 'logical' })        // optionals are ABSENT, not null/0
  })
  test('full record', () => {
    const r = ok({ reference: 'kvrn-prod-2026-10-04.dump', sizeBytes: 123456789, sha256: SHA.toUpperCase(), notes: 'weekly, from Codespaces' })
    expect(r).toEqual({ ok: true, value: { backupAt: iso(1), type: 'logical', reference: 'kvrn-prod-2026-10-04.dump', sizeBytes: 123456789, sha256: SHA, notes: 'weekly, from Codespaces' } })
  })
  test.each(['logical', 'provider_snapshot', 'pitr_marker', 'other'])('type %s accepted', t => { expect(ok({ type: t }).ok).toBe(true) })
  test.each(['', 'LOGICAL', 'dump', 'physical', null, 5, undefined])('type %p rejected', t => {
    expect(validateBackupInput({ backupAt: iso(1), type: t }, NOW).ok).toBe(false)
  })
  test('missing time rejected', () => { expect(validateBackupInput({ type: 'logical' }, NOW).ok).toBe(false) })
  test.each(['', ' ', null, undefined])('empty optional %p is treated as not provided', v => {
    const r = ok({ reference: v, sizeBytes: v, sha256: v, notes: v }); expect(r.ok).toBe(true)
    expect(Object.keys((r as any).value).sort()).toEqual(['backupAt', 'type'])
  })
  test('unexpected fields are refused (nothing can be smuggled into storage)', () => {
    for (const k of ['databaseUrl', 'password', 'path', 'env', 'token', 'ip_address']) expect(ok({ [k]: 'x' }).ok).toBe(false)
  })
  test.each([[[]], ['text'], [null], [5]])('non-object body %p rejected', b => { expect(validateBackupInput(b, NOW).ok).toBe(false) })
})

describe('checksum, size, reference, notes', () => {
  test('sha256: exactly 64 hex, lower-cased', () => {
    expect(validateSha256('AbCdEf0123456789'.repeat(4))).toEqual({ ok: true, value: 'abcdef0123456789'.repeat(4) })
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${SHA} `.repeat(2), 'sha256:' + SHA, 'd41d8cd98f00b204e9800998ecf8427e']) {
      expect(validateSha256(bad).ok).toBe(false)                                  // incl. a 32-char MD5: not accepted
    }
    expect(validateSha256(12345).ok).toBe(false)
  })
  test('size: whole non-negative bytes; unknown stays unknown, 0 is a real zero', () => {
    expect(validateSizeBytes(undefined)).toEqual({ ok: true, value: undefined })
    expect(validateSizeBytes('')).toEqual({ ok: true, value: undefined })
    expect(validateSizeBytes(0)).toEqual({ ok: true, value: 0 })
    expect(validateSizeBytes('2048')).toEqual({ ok: true, value: 2048 })
    for (const bad of [-1, 1.5, '1.5', '1e6', NaN, Infinity, 2e15, '12 MB', true]) expect(validateSizeBytes(bad as any).ok).toBe(false)
  })
  test.each(['kvrn-prod-2026-10-04.dump', 'neon branch br-quiet-sun-123', 'snapshot (weekly) #4', 'pitr:2026-10-04'])('reference %p accepted', r => {
    expect(validateReference(r).ok).toBe(true)
  })
  test.each([
    ['unix path', '/home/codespace/backup.dump'], ['home path', '~/backup.dump'], ['relative path', 'evidence/backup.dump'],
    ['windows path', 'C:\\backups\\x.dump'], ['traversal', 'a..b'], ['URL', 'https://example.com/backup'],
    ['connection string', 'postgresql://u:p@host/db'], ['too long', 'a'.repeat(LIMITS.reference + 1)],
    ['newline', 'a\nb'], ['leading dot', '.hidden'], ['query string', 'file?token=abc'],
  ])('reference rejects %s', (_n, r) => { expect(validateReference(r).ok).toBe(false) })
  test.each([
    'postgresql://user:pass@ep-x.neon.tech/db', 'postgres://a', 'https://signed.example/x?sig=1', 'sk_live_abcdef', 'sk_test_x', 'whsec_abc',
    'password=hunter2', 'Password: hunter2', 'api_key = abc', 'token: abc', 'Authorization: Bearer abcdefghijklmnop', 'DATABASE_URL set to x',
    '-----BEGIN PRIVATE KEY-----', 'AKIAABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(30), 'STRIPE_SECRET_KEY value',
  ])('notes refuse secret-looking text: %s', n => {
    expect(looksSecret(n)).toBe(true)
    const r = validateNotes(n); expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(n)
  })
  test('ordinary notes are fine, including a checksum-looking or timestamp-looking string', () => {
    for (const n of ['Weekly dump taken from Codespaces after the release.', `sha256 ${SHA}`, 'Restored to a scratch branch at 10:05 UTC; row counts matched.']) {
      expect(validateNotes(n).ok).toBe(true)
    }
  })
  test('oversized and control-character notes are rejected', () => {
    expect(validateNotes('x'.repeat(LIMITS.notes + 1)).ok).toBe(false)
    expect(validateNotes('x'.repeat(LIMITS.notes)).ok).toBe(true)
    expect(validateNotes('bad\u0000byte').ok).toBe(false)
    expect(validateNotes(42 as any).ok).toBe(false)
  })
  test('request bodies: JSON only and size-bounded', () => {
    expect(parseJsonBody('{"a":1}').ok).toBe(true)
    expect(parseJsonBody('not json').ok).toBe(false)
    expect(parseJsonBody(JSON.stringify({ notes: 'x'.repeat(LIMITS.bodyBytes) })).ok).toBe(false)
  })
})

describe('verification and drill input', () => {
  const id = randomUUID()
  test('verification: id, time and result required; notes optional', () => {
    expect(validateVerificationInput({ backupId: id, verifiedAt: iso(0, 60_000), result: 'passed' }, NOW).ok).toBe(true)
    for (const bad of [{ verifiedAt: iso(1), result: 'passed' }, { backupId: 'nope', verifiedAt: iso(1), result: 'passed' },
      { backupId: id, result: 'passed' }, { backupId: id, verifiedAt: iso(1), result: 'ok' }, { backupId: id, verifiedAt: '2099-01-01T00:00:00Z', result: 'passed' },
      { backupId: id, verifiedAt: iso(1), result: 'passed', extra: 1 }]) {
      expect(validateVerificationInput(bad, NOW).ok).toBe(false)
    }
  })
  test('drill: time and result required; runbook ref and notes optional and checked', () => {
    expect(validateDrillInput({ drillAt: iso(2), result: 'passed_with_issues' }, NOW).ok).toBe(true)
    expect(validateDrillInput({ drillAt: iso(2), result: 'passed', runbookRef: '97c761a', notes: 'ok' }, NOW).ok).toBe(true)
    for (const bad of [{ result: 'passed' }, { drillAt: iso(2) }, { drillAt: iso(2), result: 'great' },
      { drillAt: iso(2), result: 'passed', runbookRef: '/etc/passwd' }, { drillAt: iso(2), result: 'passed', notes: 'password=x' },
      { drillAt: iso(2), result: 'passed', runbookRef: 'a'.repeat(LIMITS.runbookRef + 1) }]) {
      expect(validateDrillInput(bad, NOW).ok).toBe(false)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. READING ROWS BACK: association, malformed and unrelated rows
// ═════════════════════════════════════════════════════════════════════════════
describe('association: only real, well-formed events count', () => {
  test('a valid backup row is read back, with absent optionals as null (unknown), not zero', () => {
    const b = mkBackup(1)
    const a = assemble([b])
    expect(a.backups).toHaveLength(1)
    expect(a.backups[0]).toMatchObject({ id: b.id, type: 'logical', reference: null, sizeBytes: null, sha256: null, notes: null })
    expect(a.backups[0].verification).toEqual({ state: 'not_verified', latest: null, testsRecorded: 0 })
  })
  test('unrelated audit rows are not mistaken for backups', () => {
    const rows = [
      auditRow({ action: 'create', resource: 'provider_usage_snapshot', payload: { provider: 'Neon' } }),
      auditRow({ action: BACKUP_ACTION, resource: 'orders', resource_id: 'x', payload: backupPayload(1) }),                 // wrong resource
      auditRow({ action: 'update', resource: BACKUP_RESOURCE, payload: backupPayload(1) }),                                  // wrong action
    ]
    const a = assemble(rows)
    expect(a.backups).toHaveLength(0)
    expect(a.ignored.backups).toBe(3)
  })
  test.each([
    ['null payload', null], ['string payload', 'oops'], ['array payload', []], ['broken JSON string', '{not json'],
    ['wrong version', { v: 2, backupAt: iso(1), type: 'logical' }], ['no version', { backupAt: iso(1), type: 'logical' }],
    ['bad type', { v: 1, backupAt: iso(1), type: 'tape' }], ['bad time', { v: 1, backupAt: 'soon', type: 'logical' }],
    ['bad sha', { v: 1, backupAt: iso(1), type: 'logical', sha256: 'zz' }], ['secret in notes', { v: 1, backupAt: iso(1), type: 'logical', notes: 'password=x' }],
    ['negative size', { v: 1, backupAt: iso(1), type: 'logical', sizeBytes: -5 }],
  ])('a malformed payload (%s) is skipped without breaking the page', (_n, payload) => {
    const id = randomUUID()
    const good = mkBackup(2)
    const a = assemble([auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id, payload }), good])
    expect(a.backups.map(b => b.id)).toEqual([good.id])
    expect(a.ignored.backups).toBe(1)
    expect(() => buildDashboard(a, NOW)).not.toThrow()
  })
  test('resource_id must equal the row id; a non-uuid id is ignored', () => {
    const id = randomUUID()
    expect(assemble([auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: randomUUID(), payload: backupPayload(1) })]).backups).toHaveLength(0)
    expect(assemble([auditRow({ id: 'not-a-uuid', action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: 'not-a-uuid', payload: backupPayload(1) })]).backups).toHaveLength(0)
  })
  test('extra keys in a stored payload are never passed through', () => {
    const id = randomUUID()
    const a = assemble([auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id,
      payload: { ...backupPayload(1), databaseUrl: 'postgresql://u:p@h/d', password: 'x', env: { A: 1 } } })])
    expect(JSON.stringify(a)).not.toMatch(/databaseUrl|password|postgresql|env/)
  })
  test('payload stored as a JSON string is still read (driver differences)', () => {
    const id = randomUUID()
    expect(parseBackupPayload(JSON.stringify(backupPayload(1)))).not.toBeNull()
    expect(assemble([auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id, payload: JSON.stringify(backupPayload(1)) })]).backups).toHaveLength(1)
  })

  test('a restore verification must reference a REAL recorded backup', () => {
    const b = mkBackup(3)
    const ghost = randomUUID()
    const orphan = auditRow({ action: VERIFY_ACTION, resource: BACKUP_RESOURCE, resource_id: ghost, payload: { v: 1, backupId: ghost, verifiedAt: iso(1), result: 'passed' } })
    const a = assemble([b], [mkVerify(b, 1), orphan])
    expect(a.verifications).toHaveLength(1)
    expect(a.ignored.verifications).toBe(1)
    expect(a.backups[0].verification.state).toBe('verified')
  })
  test('a verification whose resource_id disagrees with its payload is ignored', () => {
    const b = mkBackup(3), other = mkBackup(3)
    const v = auditRow({ action: VERIFY_ACTION, resource: BACKUP_RESOURCE, resource_id: other.id as string, payload: { v: 1, backupId: b.id, verifiedAt: iso(1), result: 'passed' } })
    expect(assemble([b, other], [v]).verifications).toHaveLength(0)
  })
  test('a verification dated before its backup cannot count', () => {
    const b = mkBackup(3)
    expect(assemble([b], [mkVerify(b, 5)]).verifications).toHaveLength(0)
  })
  test('another table of rows pretending to be a backup (a drill row) is not a backup', () => {
    const d = mkDrill(1)
    expect(assemble([d]).backups).toHaveLength(0)
    expect(assemble([], [], [mkBackup(1)]).drills).toHaveLength(0)
  })
  test('duplicate row ids count once', () => {
    const b = mkBackup(1)
    expect(assemble([b, b]).backups).toHaveLength(1)
  })
})

describe('events are derived, never overwritten', () => {
  test('a later FAILED test supersedes an earlier pass for that backup, and both stay in the record', () => {
    const b = mkBackup(10)
    const a = assemble([b], [mkVerify(b, 8, 'passed'), mkVerify(b, 2, 'failed')])
    expect(a.backups[0].verification.state).toBe('failed')
    expect(a.backups[0].verification.testsRecorded).toBe(2)
    expect(a.verifications.map(v => v.result)).toEqual(['failed', 'passed'])
  })
  test('a later pass after a failure restores "verified"', () => {
    const b = mkBackup(10)
    expect(assemble([b], [mkVerify(b, 8, 'failed'), mkVerify(b, 2, 'passed')]).backups[0].verification.state).toBe('verified')
  })
  test('the latest test is ordered by when the TEST happened, not when it was typed in', () => {
    const b = mkBackup(10)
    // the failed test happened earlier but was typed in later
    const a = assemble([b], [mkVerify(b, 2, 'passed', 100), mkVerify(b, 6, 'failed', 0)])
    expect(a.backups[0].verification.state).toBe('verified')
  })
  test('backups are ordered newest restore point first, regardless of typing order', () => {
    const older = mkBackup(9, {}, 0), newer = mkBackup(1, {}, 500)
    expect(assemble([older, newer]).backups.map(b => b.id)).toEqual([newer.id, older.id])
    const backDated = mkBackup(20, {}, 0)       // typed in last, but an old restore point
    expect(assemble([newer, backDated]).backups[0].id).toBe(newer.id)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. READINESS / STALENESS
// ═════════════════════════════════════════════════════════════════════════════
describe('empty state: unknown, not green and not zero', () => {
  const r = computeReadiness(assemble(), NOW)
  test('every card is unknown with no timestamp and no age', () => {
    for (const e of [r.backup, r.restoreVerification, r.drill]) {
      expect(e.state).toBe('unknown'); expect(e.at).toBeNull(); expect(e.ageDays).toBeNull()
    }
    expect(r.backup.backupId).toBeNull(); expect(r.backup.verification).toBeNull(); expect(r.drill.result).toBeNull()
  })
  test('overall is UNKNOWN with a reason; labels never say healthy/verified', () => {
    expect(r.overall.state).toBe('unknown')
    expect(r.overall.reasons.join(' ')).toMatch(/No backup has been recorded/)
    expect(OVERALL_LABEL.unknown).toMatch(/UNKNOWN/)
    for (const label of [OVERALL_LABEL.unknown, BACKUP_LABEL.unknown, VERIFICATION_LABEL.unknown]) expect(label).toMatch(/^UNKNOWN/)
  })
  test('the empty dashboard serialises with no invented numbers', () => {
    const d = buildDashboard(assemble(), NOW)
    expect(d.backups).toEqual([]); expect(d.drills).toEqual([])
    expect(JSON.stringify(d.readiness)).not.toMatch(/"ageDays":0\b/)
  })
  test('zero drills while backups exist is still unknown for the drill', () => {
    const r2 = computeReadiness(assemble([mkBackup(1)]), NOW)
    expect(r2.drill.state).toBe('unknown'); expect(r2.drill.at).toBeNull()
  })
})

describe('staleness boundaries (strictly older than the threshold is stale)', () => {
  test('the thresholds live in one place with the documented defaults', () => {
    expect(STALENESS_DAYS).toEqual({ backup: 7, restoreVerification: 30, drill: 90 })
  })
  test.each([
    ['backup', 7, (n: number, ms: number) => computeReadiness(assemble([mkBackup(n, {}, 0)].map(r => ({ ...r, payload: { ...(r.payload as any), backupAt: iso(n, ms) } }))), NOW).backup],
  ])('%s: exactly at the limit is current, one millisecond over is stale', (_n, days, run) => {
    expect(run(days, 0).state).toBe('current')
    expect(run(days, 1).state).toBe('stale')
    expect(run(days, -1).state).toBe('current')
  })
  test('restore test: 30 days exactly is current, over is stale', () => {
    const b = mkBackup(40)
    const at = (ms: number) => ({ ...mkVerify(b, 30), payload: { v: 1, backupId: b.id, verifiedAt: iso(30, ms), result: 'passed' } })
    expect(computeReadiness(assemble([b], [at(0)]), NOW).restoreVerification.state).toBe('current')
    expect(computeReadiness(assemble([b], [at(1)]), NOW).restoreVerification.state).toBe('stale')
  })
  test('drill: 90 days exactly is current, over is stale', () => {
    const at = (ms: number) => ({ ...mkDrill(90), payload: { v: 1, drillAt: iso(90, ms), result: 'passed' } })
    expect(computeReadiness(assemble([], [], [at(0)]), NOW).drill.state).toBe('current')
    expect(computeReadiness(assemble([], [], [at(1)]), NOW).drill.state).toBe('stale')
  })
  test('isStale / ageDays helpers; a slightly-future timestamp is age 0, never negative', () => {
    expect(isStale(iso(7), 7, NOW)).toBe(false); expect(isStale(iso(7, 1), 7, NOW)).toBe(true)
    expect(ageDays(iso(2), NOW)).toBeCloseTo(2, 6)
    expect(ageDays(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(0)
  })
  test('thresholds can be overridden by the caller (one place to adjust)', () => {
    const r = computeReadiness(assemble([mkBackup(3)]), NOW, { backup: 2, restoreVerification: 30, drill: 90 })
    expect(r.backup.state).toBe('stale'); expect(r.backup.thresholdDays).toBe(2)
  })
})

describe('recorded is not verified; verified can go stale', () => {
  test('a recent backup with no restore test is RECORDED, never VERIFIED', () => {
    const r = computeReadiness(assemble([mkBackup(1)]), NOW)
    expect(r.backup.state).toBe('current'); expect(r.backup.verification).toBe('not_verified')
    expect(r.restoreVerification.state).toBe('unknown')
    expect(r.overall.state).toBe('recorded')
    expect(r.overall.reasons.join(' ')).toMatch(/not a verified backup/)
  })
  test('everything current and passing is VERIFIED (and only then)', () => {
    const b = mkBackup(1)
    const r = computeReadiness(assemble([b], [mkVerify(b, 0, 'passed')], [mkDrill(10)]), NOW)
    expect(r.overall.state).toBe('verified'); expect(r.overall.reasons).toEqual([])
    expect(r.backup.verification).toBe('verified')
  })
  test('the latest backup\u2019s own passing test going stale makes the overall state STALE (custom thresholds)', () => {
    const b = mkBackup(40)
    const t = { backup: 60, restoreVerification: 30, drill: 90 }
    const r = computeReadiness(assemble([b], [mkVerify(b, 35, 'passed')], [mkDrill(5)]), NOW, t)
    expect(r.backup.state).toBe('current'); expect(r.restoreVerification.state).toBe('stale')
    expect(r.overall.state).toBe('stale')
    expect(r.overall.reasons.join(' ')).toMatch(/passing restore test is older than 30 days/)
  })
  test('a stale latest backup outranks everything good behind it', () => {
    const b = mkBackup(8)
    const r = computeReadiness(assemble([b], [mkVerify(b, 1, 'passed')], [mkDrill(1)]), NOW)
    expect(r.overall.state).toBe('stale'); expect(r.backup.state).toBe('stale')
  })
  test('a failed restore test is FAILED, even though a backup exists and an older test passed', () => {
    const b = mkBackup(2)
    const r = computeReadiness(assemble([b], [mkVerify(b, 5, 'passed'), mkVerify(b, 1, 'failed')], [mkDrill(1)]), NOW)
    expect(r.restoreVerification.state).toBe('failed'); expect(r.overall.state).toBe('failed')
  })
  test('a failed DR drill is FAILED; passed-with-issues is only RECORDED', () => {
    const b = mkBackup(1)
    expect(computeReadiness(assemble([b], [mkVerify(b, 0)], [mkDrill(1, 'failed')]), NOW).overall.state).toBe('failed')
    const r = computeReadiness(assemble([b], [mkVerify(b, 0)], [mkDrill(1, 'passed_with_issues')]), NOW)
    expect(r.overall.state).toBe('recorded'); expect(r.drill.state).toBe('current')
  })
  test('no drill recorded: RECORDED (not verified); a stale drill: STALE', () => {
    const b = mkBackup(1)
    expect(computeReadiness(assemble([b], [mkVerify(b, 0)]), NOW).overall.state).toBe('recorded')
    expect(computeReadiness(assemble([b], [mkVerify(b, 0)], [mkDrill(91)]), NOW).overall.state).toBe('stale')
  })
  test('staleness is measured from when the backup happened, not when it was typed in', () => {
    const typedToday = mkBackup(30, {}, 0)          // a month-old restore point entered just now
    expect(computeReadiness(assemble([typedToday]), NOW).backup.state).toBe('stale')
  })
  test('readiness depends only on events: an event for an ignored/unknown backup never improves it', () => {
    const ghostVerify = auditRow({ action: VERIFY_ACTION, resource: BACKUP_RESOURCE, resource_id: randomUUID(), payload: { v: 1, backupId: randomUUID(), verifiedAt: iso(1), result: 'passed' } })
    expect(computeReadiness(assemble([], [ghostVerify], [mkDrill(1)]), NOW).overall.state).toBe('unknown')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3b. REVISION 1: OVERALL READINESS IS ABOUT THE LATEST BACKUP ITSELF
// ═════════════════════════════════════════════════════════════════════════════
describe('overall readiness never contradicts the latest backup', () => {
  /** Newest backup A and older backup B (both within the 7-day limit). */
  const pair = () => ({ A: mkBackup(1, { reference: 'A.dump' }, 0), B: mkBackup(3, { reference: 'B.dump' }, 0) })

  test('1. newest backup FAILED its test, an older backup passed LATER, drill current: overall FAILED, never VERIFIED', () => {
    const { A, B } = pair()
    const r = computeReadiness(assemble([A, B], [mkVerify(A, 0.5, 'failed'), mkVerify(B, 0, 'passed')], [mkDrill(5)]), NOW)
    expect(r.backup.backupId).toBe(A.id)
    expect(r.backup.verification).toBe('failed')                 // the latest backup says FAILED
    expect(r.restoreVerification.state).toBe('current')          // the global card still reports B's newer pass...
    expect(r.restoreVerification.backupId).toBe(B.id)            // ...and says which backup it applies to
    expect(r.overall.state).toBe('failed')
    expect(r.overall.state).not.toBe('verified')
    expect(r.overall.reasons.join(' ')).toMatch(/latest backup.s own restore test failed/)
    expect(r.overall.notes.join(' ')).toMatch(/different, older backup/)
  })

  test('2. newest backup NEVER tested, an older backup has a recent pass, drill current: RECORDED, never VERIFIED', () => {
    const { A, B } = pair()
    const r = computeReadiness(assemble([A, B], [mkVerify(B, 0, 'passed')], [mkDrill(5)]), NOW)
    expect(r.backup.verification).toBe('not_verified')
    expect(r.restoreVerification).toMatchObject({ state: 'current', backupId: B.id })
    expect(r.overall.state).toBe('recorded')
    expect(OVERALL_LABEL[r.overall.state]).toBe('RECORDED · NOT YET FULLY VERIFIED')
    expect(r.overall.reasons.join(' ')).toMatch(/latest backup has not itself been restore-tested/)
    expect(r.overall.notes.join(' ')).toMatch(/does not prove the latest backup restores/)
  })

  test('3. newest backup VERIFIED (its own test passed), drill current and passed: VERIFIED', () => {
    const { A, B } = pair()
    const r = computeReadiness(assemble([A, B], [mkVerify(A, 0, 'passed')], [mkDrill(5)]), NOW)
    expect(r.backup.verification).toBe('verified')
    expect(r.overall.state).toBe('verified'); expect(r.overall.reasons).toEqual([])
    expect(r.overall.notes).toEqual([])
  })

  test('4. a NEWER failure on another backup still wins over a verified latest backup', () => {
    const { A, B } = pair()
    const r = computeReadiness(assemble([A, B], [mkVerify(A, 0.5, 'passed'), mkVerify(B, 0, 'failed')], [mkDrill(5)]), NOW)
    expect(r.backup.verification).toBe('verified')
    expect(r.restoreVerification).toMatchObject({ state: 'failed', backupId: B.id })
    expect(r.overall.state).toBe('failed')
    expect(r.overall.reasons.join(' ')).toMatch(/another recorded backup\) failed/)
  })

  test('4b. an OLDER failure on another backup does not block a latest backup that passed afterwards', () => {
    const { A, B } = pair()
    const r = computeReadiness(assemble([A, B], [mkVerify(B, 2, 'failed'), mkVerify(A, 0, 'passed')], [mkDrill(5)]), NOW)
    expect(r.restoreVerification.state).toBe('current')
    expect(r.overall.state).toBe('verified')
  })

  describe('5. failure together with staleness: the failure is never hidden', () => {
    test('stale latest backup whose own test failed -> FAILED (stale reason also listed, failure first)', () => {
      const b = mkBackup(10)
      const r = computeReadiness(assemble([b], [mkVerify(b, 8, 'failed')], [mkDrill(5)]), NOW)
      expect(r.backup.state).toBe('stale')
      expect(r.overall.state).toBe('failed')
      expect(r.overall.reasons[0]).toMatch(/restore test failed/)
      expect(r.overall.reasons.join(' ')).toMatch(/older than 7 days/)
    })
    test('stale DR drill that is ALSO a failure stays FAILED; a stale drill alone is STALE', () => {
      const b = mkBackup(1)
      expect(computeReadiness(assemble([b], [mkVerify(b, 0)], [mkDrill(120, 'failed')]), NOW).overall.state).toBe('failed')
      expect(computeReadiness(assemble([b], [mkVerify(b, 0)], [mkDrill(120, 'passed')]), NOW).overall.state).toBe('stale')
    })
    test('failed drill + latest backup never restore-tested + stale: FAILED outranks STALE outranks RECORDED', () => {
      const b = mkBackup(9)
      const r = computeReadiness(assemble([b], [], [mkDrill(1, 'failed')]), NOW)
      expect(r.overall.state).toBe('failed')
      expect(r.overall.reasons.length).toBeGreaterThanOrEqual(3)
    })
    test('severity order: unknown > failed > stale > recorded > verified', () => {
      const none = computeReadiness(assemble(), NOW).overall.state
      const stale = computeReadiness(assemble([mkBackup(9)]), NOW).overall.state                 // stale + unverified
      const recorded = computeReadiness(assemble([mkBackup(1)]), NOW).overall.state              // only incomplete
      expect([none, stale, recorded]).toEqual(['unknown', 'stale', 'recorded'])
    })
  })

  test('6. a drill that passed with issues keeps the overall state below VERIFIED', () => {
    const b = mkBackup(1)
    const r = computeReadiness(assemble([b], [mkVerify(b, 0, 'passed')], [mkDrill(5, 'passed_with_issues')]), NOW)
    expect(r.overall.state).toBe('recorded'); expect(r.overall.state).not.toBe('verified')
    expect(r.overall.reasons.join(' ')).toMatch(/passed with issues/)
  })

  test('VERIFIED is impossible unless the latest backup is current, its own test passed, and the drill is current and fully passed', () => {
    // exhaustive over the evidence combinations that matter
    for (const age of [1, 9]) for (const own of ['none', 'passed', 'failed'] as const)
      for (const other of ['none', 'passed', 'failed'] as const) for (const drill of ['none', 'passed', 'passed_with_issues', 'failed', 'stale'] as const) {
        const A = mkBackup(age, {}, 0), B = mkBackup(age + 2, {}, 0)
        const ver: AuditRow[] = []
        const ownAt = Math.max(0.5, age - 1)                    // after A's own backup time
        if (own !== 'none') ver.push(mkVerify(A, ownAt, own))
        if (other !== 'none') ver.push(mkVerify(B, ownAt / 2, other))   // always NEWER than A's test, so a failure there must win
        const drills = drill === 'none' ? [] : [mkDrill(drill === 'stale' ? 120 : 5, drill === 'stale' ? 'passed' : drill)]
        const r = computeReadiness(assemble([A, B], ver, drills), NOW)
        const mayBeVerified = age === 1 && own === 'passed' && other !== 'failed' && drill === 'passed'
        if (r.overall.state === 'verified') expect(mayBeVerified).toBe(true)
        else expect(mayBeVerified).toBe(false)
        if (r.backup.verification !== 'verified') expect(r.overall.state).not.toBe('verified')
        if (r.backup.verification === 'failed') expect(r.overall.state).toBe('failed')
      }
  })

  test('the UI success sentence implies the latest backup itself is restore-tested, and there is no stale wording', () => {
    const ui = read('app/admin/backups/BackupsClient.tsx')
    expect(ui).toContain('The latest backup has itself been restore-tested (passed)')
    expect(ui).not.toContain('Recent backup, restore test and drill are all recorded')
    expect(ui).toContain('Applies to:')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. SERVICE: APPEND-ONLY, ASSOCIATION AT WRITE TIME
// ═════════════════════════════════════════════════════════════════════════════
describe('service writes are appends', () => {
  test('recording a backup inserts exactly one row; reading it back works', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    const { id } = await svc.recordBackup({ backupAt: iso(1), type: 'logical', reference: 'x.dump', sha256: SHA }, 'owner@kvrn.test')
    expect(sql.rows).toHaveLength(1)
    expect(sql.rows[0]).toMatchObject({ id, resource_id: id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, actor_email: 'owner@kvrn.test' })
    const d = await svc.getDashboard(NOW)
    expect(d.backups[0]).toMatchObject({ id, recordedBy: 'owner@kvrn.test', sha256: SHA })
  })
  test('recording a verification APPENDS: the original backup row is untouched', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    const { id } = await svc.recordBackup({ backupAt: iso(2), type: 'pitr_marker' }, 'a@x.test')
    const before = JSON.stringify(sql.rows[0])
    const r = await svc.recordVerification({ backupId: id, verifiedAt: iso(1), result: 'passed', notes: 'row counts matched' }, 'b@x.test')
    expect(r.ok).toBe(true)
    expect(sql.rows).toHaveLength(2)
    expect(JSON.stringify(sql.rows[0])).toBe(before)
    expect(sql.rows[1]).toMatchObject({ action: VERIFY_ACTION, resource: BACKUP_RESOURCE, resource_id: id, actor_email: 'b@x.test' })
    const d = await svc.getDashboard(NOW)
    expect(d.backups[0].verification.state).toBe('verified')
    expect(d.backups[0].recordedBy).toBe('a@x.test')
  })
  test('recording a drill appends a new event each time', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    await svc.recordDrill({ drillAt: iso(5), result: 'passed' }, 'a@x.test')
    await svc.recordDrill({ drillAt: iso(1), result: 'failed', notes: 'restore step 4 failed' }, 'a@x.test')
    expect(sql.rows).toHaveLength(2)
    const d = await svc.getDashboard(NOW)
    expect(d.drills.map(x => x.result)).toEqual(['failed', 'passed'])
    expect(d.readiness.drill.state).toBe('failed')
  })
  test('no statement the service issues is anything but SELECT or INSERT (never UPDATE/DELETE)', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    const { id } = await svc.recordBackup({ backupAt: iso(1), type: 'other' }, 'a@x.test')
    await svc.recordVerification({ backupId: id, verifiedAt: iso(0, 1000), result: 'passed' }, 'a@x.test')
    await svc.recordDrill({ drillAt: iso(1), result: 'passed' }, 'a@x.test')
    await svc.getDashboard(NOW)
    expect(sql.statements.length).toBeGreaterThan(0)
    for (const s of sql.statements) expect(s).toMatch(/^(SELECT|INSERT)\b/)
    for (const s of sql.statements) expect(s).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i)
  })
  test('verification of a non-existent backup is refused and writes nothing', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    const r = await svc.recordVerification({ backupId: randomUUID(), verifiedAt: iso(1), result: 'passed' }, 'a@x.test')
    expect(r).toEqual({ ok: false, reason: 'not_found' })
    expect(sql.rows).toHaveLength(0)
  })
  test('verification cannot point at an unrelated audit row, a drill, or a malformed backup', async () => {
    const drill = mkDrill(1)
    const bad = (() => { const id = randomUUID(); return auditRow({ id, action: BACKUP_ACTION, resource: BACKUP_RESOURCE, resource_id: id, payload: { v: 1, backupAt: 'soon', type: 'logical' } }) })()
    const unrelated = auditRow({ action: 'create', resource: 'ad_spend' })
    const sql = makeFake([drill as FakeRow, bad as FakeRow, unrelated as FakeRow]); const svc = createBackupService(sql)
    for (const id of [drill.id, bad.id, unrelated.id] as string[]) {
      expect(await svc.recordVerification({ backupId: id, verifiedAt: iso(0, 1000), result: 'passed' }, 'a@x.test')).toEqual({ ok: false, reason: 'not_found' })
    }
    expect(sql.rows).toHaveLength(3)
  })
  test('a test dated before the backup is refused', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    const { id } = await svc.recordBackup({ backupAt: iso(2), type: 'logical' }, 'a@x.test')
    expect(await svc.recordVerification({ backupId: id, verifiedAt: iso(3), result: 'passed' }, 'a@x.test')).toEqual({ ok: false, reason: 'before_backup' })
    expect(sql.rows).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. RESPONSE HYGIENE
// ═════════════════════════════════════════════════════════════════════════════
describe('the dashboard response', () => {
  test('is bounded: at most 25 backups and 25 drills, however many rows exist', async () => {
    const rows: FakeRow[] = []
    for (let i = 0; i < 60; i++) rows.push(mkBackup(i % 5, {}, i)), rows.push(mkDrill(i % 5, 'passed', i))
    const d = await createBackupService(makeFake(rows)).getDashboard(NOW)
    expect(d.backups).toHaveLength(LIMITS.historyShown); expect(d.drills).toHaveLength(LIMITS.historyShown)
  })
  test('the service reads with bounded LIMITs and only its own action/resource pairs', async () => {
    const sql = makeFake(); await createBackupService(sql).getDashboard(NOW)
    expect(sql.statements).toHaveLength(3)
    for (const s of sql.statements) { expect(s).toMatch(/LIMIT \$3$/); expect(s).toMatch(/WHERE action = \$1 AND resource = \$2/) }
  })
  test('no unrelated audit payloads, no ip address, no secrets, no env values in the JSON', async () => {
    const poison: FakeRow[] = [
      { ...auditRow({ action: 'create', resource: 'provider_usage_snapshot', payload: { provider: 'Neon', apiKey: 'sk_live_SECRET' } }), ip_address: '203.0.113.7' },
      { ...auditRow({ action: 'refund', resource: 'orders', payload: { stripe: 'pi_SECRET', email: 'customer@example.com' } }), ip_address: '203.0.113.8' },
    ]
    const b = mkBackup(1, { notes: 'ok' }); (b as FakeRow).ip_address = '198.51.100.9'
    const sql = makeFake([...poison, b as FakeRow]); process.env.DATABASE_URL_BACKUP_TEST_SENTINEL = 'postgresql://sentinel'
    const json = JSON.stringify(await createBackupService(sql).getDashboard(NOW))
    delete process.env.DATABASE_URL_BACKUP_TEST_SENTINEL
    for (const bad of ['SECRET', 'customer@example.com', '203.0.113', '198.51.100', 'sentinel', 'provider_usage_snapshot', 'ip_address', 'payload', 'DATABASE_URL', 'apiKey']) {
      expect(json).not.toContain(bad)
    }
  })
  test('each backup carries only the documented fields', async () => {
    const sql = makeFake(); const svc = createBackupService(sql)
    await svc.recordBackup({ backupAt: iso(1), type: 'logical' }, 'a@x.test')
    const d = await svc.getDashboard(NOW)
    expect(Object.keys(d.backups[0]).sort()).toEqual(['backupAt', 'id', 'notes', 'recordedAt', 'recordedBy', 'reference', 'sha256', 'sizeBytes', 'type', 'verification'])
    expect(Object.keys(d).sort()).toEqual(['backups', 'drills', 'generatedAt', 'ignored', 'readiness', 'thresholds'])
  })
  test('ignored malformed rows are reported as counts only', () => {
    const d = buildDashboard(assemble([auditRow({ action: BACKUP_ACTION, resource: BACKUP_RESOURCE, payload: { secret: 'sk_live_x' } })]), NOW)
    expect(d.ignored).toEqual({ backups: 1, verifications: 0, drills: 0 })
    expect(JSON.stringify(d)).not.toContain('sk_live')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. ROUTES: auth fails closed, validation fails before the database
// ═════════════════════════════════════════════════════════════════════════════
describe('admin routes', () => {
  const route = (p: string) => require(`../../app/api/admin/backups${p}/route`)
  const req = (p: string, method: string, body?: unknown, raw?: string) =>
    new NextRequest('http://localhost/api/admin/backups' + p, {
      method, ...(method === 'POST' ? { body: raw ?? JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } } : {}),
    })
  const POSTS: Array<[string, string, object]> = [
    ['', '', { backupAt: iso(1), type: 'logical' }],
    ['/verify', '/verify', { backupId: randomUUID(), verifiedAt: iso(0, 60_000), result: 'passed' }],
    ['/drills', '/drills', { drillAt: iso(1), result: 'passed' }],
  ]
  beforeEach(() => { (global as any).__BK_SQL = makeFake() })

  test.each([401, 403])('GET with status %i is rejected and the database is not touched', async status => {
    ;(global as any).__BK_DENY = status
    const res = await route('').GET(req('', 'GET'))
    expect(res.status).toBe(status)
    expect((global as any).__BK_SQL.statements).toHaveLength(0)
  })
  test.each(POSTS)('POST %p unauthenticated -> 401, no write, no read', async (p, _n, body) => {
    ;(global as any).__BK_DENY = 401
    const res = await route(p).POST(req(p, 'POST', body))
    expect(res.status).toBe(401)
    expect((global as any).__BK_SQL.statements).toHaveLength(0)
    expect((global as any).__BK_SQL.rows).toHaveLength(0)
  })
  test.each(POSTS)('POST %p forbidden (not on the allowlist) -> 403, no write', async (p, _n, body) => {
    ;(global as any).__BK_DENY = 403
    expect((await route(p).POST(req(p, 'POST', body))).status).toBe(403)
    expect((global as any).__BK_SQL.statements).toHaveLength(0)
  })
  test('the routes call requireAdmin before anything else', () => {
    for (const f of ['route.ts', 'verify/route.ts', 'drills/route.ts']) {
      const src = read('app/api/admin/backups/' + f)
      for (const m of ['GET', 'POST']) {
        const i = src.indexOf(`export async function ${m}`); if (i < 0) continue
        const body = src.slice(i)
        expect(body.indexOf('requireAdmin')).toBeGreaterThan(-1)
        expect(body.indexOf('requireAdmin')).toBeLessThan(Math.min(...['req.text', 'sql', 'createBackupService'].map(k => { const j = body.indexOf(k); return j < 0 ? 1e9 : j })))
      }
    }
  })
  test.each([
    ['invalid timestamp', { backupAt: 'soon', type: 'logical' }], ['future timestamp', { backupAt: '2099-01-01T00:00:00Z', type: 'logical' }],
    ['invalid type', { backupAt: iso(1), type: 'tape' }], ['invalid checksum', { backupAt: iso(1), type: 'logical', sha256: 'abc' }],
    ['secret in notes', { backupAt: iso(1), type: 'logical', notes: 'postgresql://u:p@h/d' }], ['oversized notes', { backupAt: iso(1), type: 'logical', notes: 'x'.repeat(2000) }],
    ['path reference', { backupAt: iso(1), type: 'logical', reference: '/home/me/x.dump' }], ['unknown field', { backupAt: iso(1), type: 'logical', databaseUrl: 'x' }],
  ])('POST /api/admin/backups with %s -> 400 and nothing is written', async (_n, body) => {
    const res = await route('').POST(req('', 'POST', body))
    expect(res.status).toBe(400)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('postgresql://')
    expect((global as any).__BK_SQL.statements).toHaveLength(0)
  })
  test('POST with a non-JSON or huge body -> 400 before the database', async () => {
    expect((await route('').POST(req('', 'POST', undefined, 'not json'))).status).toBe(400)
    expect((await route('').POST(req('', 'POST', undefined, JSON.stringify({ notes: 'x'.repeat(LIMITS.bodyBytes) })))).status).toBe(400)
    expect((global as any).__BK_SQL.statements).toHaveLength(0)
  })
  test('POST /verify for an unknown backup -> 404, nothing appended', async () => {
    const res = await route('/verify').POST(req('/verify', 'POST', { backupId: randomUUID(), verifiedAt: iso(0, 60_000), result: 'passed' }))
    expect(res.status).toBe(404); expect((global as any).__BK_SQL.rows).toHaveLength(0)
  })
  test('end to end: record -> list -> verify -> list -> drill -> list, append-only throughout', async () => {
    const sql = (global as any).__BK_SQL
    const created = await route('').POST(req('', 'POST', { backupAt: iso(1), type: 'logical', reference: 'kvrn.dump', sha256: SHA }))
    expect(created.status).toBe(201)
    const { id } = await created.json()
    let dash = await (await route('').GET(req('', 'GET'))).json()
    expect(dash.backups).toHaveLength(1); expect(dash.readiness.overall.state).toBe('recorded')
    expect(dash.backups[0].verification.state).toBe('not_verified')

    const v = await route('/verify').POST(req('/verify', 'POST', { backupId: id, verifiedAt: new Date(Date.now() - 1000).toISOString(), result: 'passed', notes: 'ok' }))
    expect(v.status).toBe(201)
    const d = await route('/drills').POST(req('/drills', 'POST', { drillAt: new Date(Date.now() - 1000).toISOString(), result: 'passed' }))
    expect(d.status).toBe(201)
    dash = await (await route('').GET(req('', 'GET'))).json()
    expect(dash.backups).toHaveLength(1)                              // still ONE backup; the test is an event on it
    expect(dash.backups[0].verification.state).toBe('verified')
    expect(dash.readiness.overall.state).toBe('verified')
    expect(sql.rows).toHaveLength(3)
    expect(sql.statements.filter((s: string) => /^INSERT/.test(s))).toHaveLength(3)
    expect(sql.statements.some((s: string) => /UPDATE|DELETE/i.test(s))).toBe(false)
  })
  test('GET responses are not cacheable', async () => {
    const res = await route('').GET(req('', 'GET'))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. SCOPE GUARDS
// ═════════════════════════════════════════════════════════════════════════════
describe('scope: additive, no schema change, nothing mutating or secret', () => {
  const FILES = ['lib/backup-records.ts', 'app/api/admin/backups/route.ts', 'app/api/admin/backups/verify/route.ts',
                 'app/api/admin/backups/drills/route.ts', 'app/admin/backups/page.tsx', 'app/admin/backups/BackupsClient.tsx']
  test('the backup dashboard added no migration of its own', () => {
    // (Was "no 023 / the chain ends at 022"; 023+ now exist for unrelated, later work.)
    const files = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => f.endsWith('.sql'))
    expect(files.some(f => /backup/i.test(f))).toBe(false)
    expect(files).toContain('022_late_payment_recovery.sql')
  })
  test('no file of the feature updates or deletes audit rows, or runs schema SQL', () => {
    for (const f of FILES) expect(code(f)).not.toMatch(/\b(UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i)
  })
  test('no environment variable, secret name, provider client or child process is read by the feature', () => {
    for (const f of FILES) {
      const c = code(f)
      expect(c).not.toMatch(/process\.env/); expect(c).not.toMatch(/child_process|execSync|spawn\(/)
      expect(c).not.toMatch(/api\.neon|neon\.tech/)
    }
  })
  test('the UI has no restore or delete control and never uses a mutating verb besides POST', () => {
    const ui = code('app/admin/backups/BackupsClient.tsx')
    expect(ui).not.toMatch(/method:\s*['"](DELETE|PUT|PATCH)['"]/)
    expect(ui).not.toMatch(/Restore now|Delete backup|Run backup|Create backup|Start restore/i)
    expect(ui).toMatch(/does not create a backup/i)
    expect(ui).toMatch(/does not restore anything/i)
  })
  test('the UI names the canonical documents by repository path and does not invent a link', () => {
    const ui = read('app/admin/backups/BackupsClient.tsx')
    for (const d of ['DISASTER-RECOVERY.md', 'DISASTER-RECOVERY-CHECKLIST.md', 'DISASTER-RECOVERY-DRILL.md']) expect(ui).toContain('kvrn/' + d)
    expect(ui).not.toMatch(/href=/)
  })
  test('no status word is hard-coded in the UI: it uses the central label tables', () => {
    const ui = code('app/admin/backups/BackupsClient.tsx')
    expect(ui).toContain('OVERALL_LABEL'); expect(ui).toContain('BACKUP_LABEL'); expect(ui).toContain('VERIFICATION_LABEL')
  })
  test('the Backups page is in the admin navigation', () => {
    const nav = read('components/admin/AdminShell.tsx')
    expect(nav).toContain("href: '/admin/backups'"); expect(nav).toContain("label: 'Backups'")
  })
  test('the runbook states that the page is recordkeeping only (and no longer says a dashboard is absent)', () => {
    const dr = read('DISASTER-RECOVERY.md')
    expect(dr).toMatch(/admin \*\*Backups\*\* page/)
    expect(dr).toMatch(/recordkeeping only/)
    expect(dr).not.toMatch(/or backup dashboard \(explicitly out of scope\)/)
  })
  test('financial, checkout and provider code is untouched by import', () => {
    for (const f of FILES) {
      const c = code(f)
      for (const m of ['financial-calculator', 'financials', 'checkout', 'inventory', 'discounts', 'affiliate', 'stripe', 'shippo', 'funnel-analytics', 'ga4']) {
        expect(c).not.toMatch(new RegExp(`from ['"][^'"]*${m}`))
      }
    }
  })
})
