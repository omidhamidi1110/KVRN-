// lib/backup-records.ts — backup / restore-verification / DR-drill RECORDKEEPING
//
// WHAT THIS IS: an append-only ledger of facts an admin typed in about backups and drills that
// happened OUTSIDE the web app. WHAT IT IS NOT: it does not create a backup, read a database
// dump, talk to Neon, run pg_dump, or restore anything. A Cloudflare Worker cannot do those
// things, and nothing here pretends otherwise. "Recorded" never means "created".
//
// STORAGE: the existing admin_audit_logs table (no migration). Three event kinds, each a row:
//
//   action                              resource       resource_id   payload (JSON, v:1)
//   backup_recorded                     backup_record  <the row id>  backupAt, type, reference?, sizeBytes?, sha256?, notes?
//   backup_restore_verified             backup_record  <backup id>   backupId, verifiedAt, result, notes?
//   disaster_recovery_drill_recorded    dr_drill       <the row id>  drillAt, result, runbookRef?, notes?
//
// Nothing is ever updated or deleted. A later restore test is a NEW row that points at the
// backup's id; "the current state of a backup" is derived by reading its events.
//
// PURE FIRST: validation, parsing, assembly and the readiness rules are plain functions with no
// I/O so they are unit-testable; the small service at the bottom is the only part that touches SQL.
//
// RULES THE WHOLE FILE ENFORCES
//   • UNKNOWN IS NOT HEALTHY. No evidence => 'unknown', never green and never "0 days".
//   • Staleness is measured from the time the BACKUP/TEST/DRILL happened (the evidence time the
//     admin entered), not from when the row was typed in.
//   • Unrelated or malformed audit rows are ignored; one bad payload cannot break the page.
//   • No secrets: free text that looks like a connection string, URL, key or password is refused.

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const BACKUP_ACTION = 'backup_recorded'
export const VERIFY_ACTION = 'backup_restore_verified'
export const DRILL_ACTION = 'disaster_recovery_drill_recorded'
export const BACKUP_RESOURCE = 'backup_record'
export const DRILL_RESOURCE = 'dr_drill'
export const PAYLOAD_VERSION = 1

export const BACKUP_TYPES = ['logical', 'provider_snapshot', 'pitr_marker', 'other'] as const
export type BackupType = typeof BACKUP_TYPES[number]
export const BACKUP_TYPE_LABEL: Record<BackupType, string> = {
  logical: 'Logical dump (pg_dump)',
  provider_snapshot: 'Provider snapshot',
  pitr_marker: 'Point-in-time restore marker',
  other: 'Other',
}

export const VERIFICATION_RESULTS = ['passed', 'failed'] as const
export type VerificationResult = typeof VERIFICATION_RESULTS[number]

export const DRILL_RESULTS = ['passed', 'passed_with_issues', 'failed'] as const
export type DrillResult = typeof DRILL_RESULTS[number]

/**
 * THE staleness thresholds, in one place. Evidence strictly OLDER than its threshold is stale;
 * evidence exactly at the threshold is still current.
 *   backup 7 days        a weekly-or-better cadence; the DR runbook's recovery objective is the
 *                        owner's own, so this is a default to adjust, not a promise
 *   restore test 30 days a monthly restore test is a common minimum for a small store
 *   DR drill 90 days     a quarterly full drill
 */
export const STALENESS_DAYS = { backup: 7, restoreVerification: 30, drill: 90 } as const
export type Thresholds = { backup: number; restoreVerification: number; drill: number }

/** Bounds on what the API will accept and return. */
export const LIMITS = {
  bodyBytes: 8 * 1024,
  reference: 200,
  runbookRef: 80,
  notes: 500,
  maxSizeBytes: 1e15,
  clockSkewMs: 5 * 60_000,
  earliest: Date.UTC(2000, 0, 1),
  historyShown: 25,
  backupRowsRead: 100,
  verificationRowsRead: 400,
  drillRowsRead: 50,
} as const

const DAY_MS = 86_400_000

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION  (every function returns a result; none throws; errors never echo the input)
// ─────────────────────────────────────────────────────────────────────────────

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/**
 * A strict ISO-8601 instant WITH an explicit zone (Z or ±hh:mm). A bare local time is refused:
 * it would silently mean different moments depending on who typed it. Calendar-impossible dates
 * (31 Feb) are refused rather than rolled over. `now` bounds the future; pass null to skip the
 * future check when re-reading an already-stored value.
 */
export function parseInstant(raw: unknown, field: string, now: Date | null): Checked<string> {
  if (typeof raw !== 'string') return fail(`${field} is required (an ISO-8601 timestamp with a time zone).`)
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(raw)
  if (!m) return fail(`${field} must be an ISO-8601 timestamp with a time zone, e.g. 2026-10-04T08:30:00Z.`)
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const s = m[6] === undefined ? 0 : Number(m[6])
  const offH = m[8] === undefined ? 0 : Number(m[8]), offM = m[9] === undefined ? 0 : Number(m[9])
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d ||
      h > 23 || mi > 59 || s > 59 || offH > 23 || offM > 59) {
    return fail(`${field} is not a real calendar date and time.`)
  }
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) return fail(`${field} is not a valid timestamp.`)
  if (t.getTime() < LIMITS.earliest) return fail(`${field} is implausibly old.`)
  if (now && t.getTime() > now.getTime() + LIMITS.clockSkewMs) return fail(`${field} cannot be in the future.`)
  return { ok: true, value: t.toISOString() }
}

/** Text that must never be stored: URLs/connection strings, key prefixes, password-ish assignments. */
const SECRET_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\//i,                       // any scheme://  (postgres://, https://…)
  /\b(sk|rk|pk)_(live|test)_/i,                           // Stripe keys
  /\bwhsec_/i, /\bAKIA[0-9A-Z]{12,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bxox[abp]-/i,
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/,
  /\bbearer\s+[A-Za-z0-9._~+\/=-]{12,}/i,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]/i,
  /\bpostgres(ql)?:/i,
  /\b(DATABASE_URL|STRIPE_[A-Z_]*|CF_API_TOKEN|NEON_API_KEY)\b/,
]
export const looksSecret = (s: string) => SECRET_PATTERNS.some(re => re.test(s))
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function optionalText(raw: unknown, field: string, max: number, multiline: boolean): Checked<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return fail(`${field} must be text.`)
  const v = raw.trim()
  if (v === '') return { ok: true, value: undefined }
  if (v.length > max) return fail(`${field} is too long (max ${max} characters).`)
  if (CONTROL.test(v) || (!multiline && /[\r\n\t]/.test(v))) return fail(`${field} contains characters that are not allowed.`)
  if (looksSecret(v)) return fail(`${field} looks like it contains a secret, URL or connection string. Remove it and record only non-secret metadata.`)
  return { ok: true, value: v }
}

/**
 * A short label or filename: letters, digits, space and . _ - : + ( ) # only. It cannot contain a
 * slash, so it can be neither a local path (which the Worker cannot read, and which would imply
 * it can) nor a URL. Example: "kvrn-prod-2026-10-04.dump" or "neon branch br-quiet-sun-123".
 */
export function validateReference(raw: unknown, field = 'reference', max: number = LIMITS.reference): Checked<string | undefined> {
  const t = optionalText(raw, field, max, false)
  if (!t.ok || t.value === undefined) return t
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._:+()#-]*$/.test(t.value)) {
    return fail(`${field} may contain only letters, digits, spaces and . _ - : + ( ) # — no slashes, paths or URLs.`)
  }
  if (/\.\./.test(t.value)) return fail(`${field} cannot contain "..".`)
  return t
}

export const validateNotes = (raw: unknown): Checked<string | undefined> => optionalText(raw, 'notes', LIMITS.notes, true)

export function validateSizeBytes(raw: unknown): Checked<number | undefined> {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: undefined }
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > LIMITS.maxSizeBytes) {
    return fail('sizeBytes must be a whole number of bytes (0 to 1e15), or left empty if unknown.')
  }
  return { ok: true, value: n }
}

/** SHA-256 only: it is the checksum the DR runbook produces (`sha256sum`). 64 hex digits, any case, stored lower-case. */
export function validateSha256(raw: unknown): Checked<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return fail('sha256 must be text.')
  const v = raw.trim()
  if (v === '') return { ok: true, value: undefined }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) return fail('sha256 must be exactly 64 hexadecimal characters.')
  return { ok: true, value: v.toLowerCase() }
}

const oneOf = <T extends string>(list: readonly T[], raw: unknown, field: string): Checked<T> =>
  typeof raw === 'string' && (list as readonly string[]).includes(raw)
    ? { ok: true, value: raw as T }
    : fail(`${field} must be one of: ${list.join(', ')}.`)

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function exactKeys(body: unknown, allowed: readonly string[]): Checked<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('Request body must be a JSON object.')
  const extra = Object.keys(body as object).filter(k => !allowed.includes(k))
  if (extra.length) return fail('Unexpected field in request. Only the documented metadata fields are accepted.')
  return { ok: true, value: body as Record<string, unknown> }
}

/** Parse a request body: size-bounded and JSON-only. Errors never echo the body. */
export function parseJsonBody(text: string): Checked<unknown> {
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return fail('Request body is too large.')
  try { return { ok: true, value: JSON.parse(text) } } catch { return fail('Request body must be valid JSON.') }
}

export interface BackupInput {
  backupAt: string; type: BackupType
  reference?: string; sizeBytes?: number; sha256?: string; notes?: string
}
export function validateBackupInput(body: unknown, now: Date | null): Checked<BackupInput> {
  const o = exactKeys(body, ['backupAt', 'type', 'reference', 'sizeBytes', 'sha256', 'notes'])
  if (!o.ok) return o
  const b = o.value
  const backupAt = parseInstant(b.backupAt, 'backupAt', now); if (!backupAt.ok) return backupAt
  const type = oneOf(BACKUP_TYPES, b.type, 'type'); if (!type.ok) return type
  const reference = validateReference(b.reference); if (!reference.ok) return reference
  const sizeBytes = validateSizeBytes(b.sizeBytes); if (!sizeBytes.ok) return sizeBytes
  const sha256 = validateSha256(b.sha256); if (!sha256.ok) return sha256
  const notes = validateNotes(b.notes); if (!notes.ok) return notes
  return { ok: true, value: strip({ backupAt: backupAt.value, type: type.value, reference: reference.value,
                                    sizeBytes: sizeBytes.value, sha256: sha256.value, notes: notes.value }) }
}

export interface VerificationInput { backupId: string; verifiedAt: string; result: VerificationResult; notes?: string }
export function validateVerificationInput(body: unknown, now: Date | null): Checked<VerificationInput> {
  const o = exactKeys(body, ['backupId', 'verifiedAt', 'result', 'notes'])
  if (!o.ok) return o
  const b = o.value
  if (typeof b.backupId !== 'string' || !UUID_RE.test(b.backupId)) return fail('backupId must be the id of a recorded backup.')
  const verifiedAt = parseInstant(b.verifiedAt, 'verifiedAt', now); if (!verifiedAt.ok) return verifiedAt
  const result = oneOf(VERIFICATION_RESULTS, b.result, 'result'); if (!result.ok) return result
  const notes = validateNotes(b.notes); if (!notes.ok) return notes
  return { ok: true, value: strip({ backupId: b.backupId.toLowerCase(), verifiedAt: verifiedAt.value, result: result.value, notes: notes.value }) }
}

export interface DrillInput { drillAt: string; result: DrillResult; runbookRef?: string; notes?: string }
export function validateDrillInput(body: unknown, now: Date | null): Checked<DrillInput> {
  const o = exactKeys(body, ['drillAt', 'result', 'runbookRef', 'notes'])
  if (!o.ok) return o
  const b = o.value
  const drillAt = parseInstant(b.drillAt, 'drillAt', now); if (!drillAt.ok) return drillAt
  const result = oneOf(DRILL_RESULTS, b.result, 'result'); if (!result.ok) return result
  const runbookRef = validateReference(b.runbookRef, 'runbookRef', LIMITS.runbookRef); if (!runbookRef.ok) return runbookRef
  const notes = validateNotes(b.notes); if (!notes.ok) return notes
  return { ok: true, value: strip({ drillAt: drillAt.value, result: result.value, runbookRef: runbookRef.value, notes: notes.value }) }
}

/** Drop undefined so an absent optional field is ABSENT in storage, not a stored null/zero. */
function strip<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

// ─────────────────────────────────────────────────────────────────────────────
// READING STORED ROWS BACK  (defensive: audit rows are shared with the whole admin)
// ─────────────────────────────────────────────────────────────────────────────

/** The columns this module reads from admin_audit_logs. No other column (e.g. ip_address) is read. */
export interface AuditRow {
  id: unknown; actor_email: unknown; action: unknown; resource: unknown
  resource_id: unknown; payload: unknown; created_at: unknown
}

const asObject = (p: unknown): Record<string, unknown> | null => {
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { return null } }
  return typeof p === 'object' && p !== null && !Array.isArray(p) ? p as Record<string, unknown> : null
}
const instantOf = (v: unknown): string | null => {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

export type BackupPayload = BackupInput
export function parseBackupPayload(payload: unknown): BackupPayload | null {
  const p = asObject(payload); if (!p || p.v !== PAYLOAD_VERSION) return null
  const r = validateBackupInput(whitelist(p, ['backupAt', 'type', 'reference', 'sizeBytes', 'sha256', 'notes']), null)
  return r.ok ? r.value : null
}
export function parseVerificationPayload(payload: unknown): VerificationInput | null {
  const p = asObject(payload); if (!p || p.v !== PAYLOAD_VERSION) return null
  const r = validateVerificationInput(whitelist(p, ['backupId', 'verifiedAt', 'result', 'notes']), null)
  return r.ok ? r.value : null
}
export function parseDrillPayload(payload: unknown): DrillInput | null {
  const p = asObject(payload); if (!p || p.v !== PAYLOAD_VERSION) return null
  const r = validateDrillInput(whitelist(p, ['drillAt', 'result', 'runbookRef', 'notes']), null)
  return r.ok ? r.value : null
}
/** Keep only known keys, and treat stored null as absent, so an old/odd row cannot smuggle extra fields out. */
function whitelist(p: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (p[k] !== undefined && p[k] !== null) out[k] = p[k]
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────

export type VerificationState = 'verified' | 'failed' | 'not_verified'

export interface VerificationEvent {
  id: string; backupId: string; verifiedAt: string; recordedAt: string
  result: VerificationResult; notes: string | null; recordedBy: string
}
export interface BackupRecord {
  id: string
  /** When the backup / restore point was taken (the time the admin entered). */
  backupAt: string
  /** When this record was typed in. */
  recordedAt: string
  recordedBy: string
  type: BackupType
  reference: string | null
  sizeBytes: number | null
  sha256: string | null
  notes: string | null
  /** Derived from this backup's own restore-test events. 'not_verified' = no test recorded. */
  verification: {
    state: VerificationState
    /** The latest test event (by the time the test happened). */
    latest: VerificationEvent | null
    testsRecorded: number
  }
}
export interface DrillRecord {
  id: string; drillAt: string; recordedAt: string; recordedBy: string
  result: DrillResult; runbookRef: string | null; notes: string | null
}

export interface Assembled {
  backups: BackupRecord[]          // newest restore point first
  verifications: VerificationEvent[] // every VALID test event, newest test first
  drills: DrillRecord[]            // newest drill first
  /** Counts only. Never the ignored rows' content. */
  ignored: { backups: number; verifications: number; drills: number }
}

const byTimeDesc = <T>(at: (x: T) => string, rec: (x: T) => string) => (a: T, b: T) =>
  at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : rec(a) < rec(b) ? 1 : rec(a) > rec(b) ? -1 : 0

export function assembleBackupData(
  backupRows: AuditRow[], verificationRows: AuditRow[], drillRows: AuditRow[],
): Assembled {
  const ignored = { backups: 0, verifications: 0, drills: 0 }

  // BACKUPS: right action AND right resource AND resource_id == own id AND a payload that fully validates.
  const backups = new Map<string, BackupRecord>()
  for (const r of backupRows) {
    const id = typeof r.id === 'string' ? r.id.toLowerCase() : ''
    const p = parseBackupPayload(r.payload)
    const recordedAt = instantOf(r.created_at)
    if (r.action !== BACKUP_ACTION || r.resource !== BACKUP_RESOURCE || !UUID_RE.test(id) ||
        typeof r.resource_id !== 'string' || r.resource_id.toLowerCase() !== id ||
        typeof r.actor_email !== 'string' || !p || !recordedAt) { ignored.backups++; continue }
    if (backups.has(id)) { ignored.backups++; continue }
    backups.set(id, {
      id, backupAt: p.backupAt, recordedAt, recordedBy: r.actor_email, type: p.type,
      reference: p.reference ?? null, sizeBytes: p.sizeBytes ?? null, sha256: p.sha256 ?? null, notes: p.notes ?? null,
      verification: { state: 'not_verified', latest: null, testsRecorded: 0 },
    })
  }

  // VERIFICATIONS: must point at a backup that really exists in the set above, and cannot predate it.
  const verifications: VerificationEvent[] = []
  for (const r of verificationRows) {
    const id = typeof r.id === 'string' ? r.id.toLowerCase() : ''
    const p = parseVerificationPayload(r.payload)
    const recordedAt = instantOf(r.created_at)
    const target = p ? backups.get(p.backupId) : undefined
    if (r.action !== VERIFY_ACTION || r.resource !== BACKUP_RESOURCE || !UUID_RE.test(id) ||
        typeof r.actor_email !== 'string' || !p || !recordedAt || !target ||
        typeof r.resource_id !== 'string' || r.resource_id.toLowerCase() !== p.backupId ||
        p.verifiedAt < target.backupAt) { ignored.verifications++; continue }
    verifications.push({ id, backupId: p.backupId, verifiedAt: p.verifiedAt, recordedAt,
                         result: p.result, notes: p.notes ?? null, recordedBy: r.actor_email })
  }
  verifications.sort(byTimeDesc(v => v.verifiedAt, v => v.recordedAt))
  for (const v of verifications) {            // newest first, so the first one seen per backup is its latest
    const b = backups.get(v.backupId)!
    b.verification.testsRecorded += 1
    if (b.verification.latest === null) {
      b.verification.latest = v
      b.verification.state = v.result === 'passed' ? 'verified' : 'failed'
    }
  }

  const drills: DrillRecord[] = []
  const seenDrill = new Set<string>()
  for (const r of drillRows) {
    const id = typeof r.id === 'string' ? r.id.toLowerCase() : ''
    const p = parseDrillPayload(r.payload)
    const recordedAt = instantOf(r.created_at)
    if (r.action !== DRILL_ACTION || r.resource !== DRILL_RESOURCE || !UUID_RE.test(id) || seenDrill.has(id) ||
        typeof r.resource_id !== 'string' || r.resource_id.toLowerCase() !== id ||
        typeof r.actor_email !== 'string' || !p || !recordedAt) { ignored.drills++; continue }
    seenDrill.add(id)
    drills.push({ id, drillAt: p.drillAt, recordedAt, recordedBy: r.actor_email, result: p.result,
                  runbookRef: p.runbookRef ?? null, notes: p.notes ?? null })
  }
  drills.sort(byTimeDesc(d => d.drillAt, d => d.recordedAt))

  return {
    backups: [...backups.values()].sort(byTimeDesc(b => b.backupAt, b => b.recordedAt)),
    verifications, drills, ignored,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// READINESS  (the staleness rules; pure)
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceState = 'unknown' | 'current' | 'stale' | 'failed'
export type OverallState = 'unknown' | 'stale' | 'failed' | 'recorded' | 'verified'

/** Age in days of an instant relative to now. A timestamp a little in the future counts as age 0. */
export function ageDays(iso: string, now: Date): number {
  return Math.max(0, now.getTime() - new Date(iso).getTime()) / DAY_MS
}
/** Strictly older than the threshold. Exactly at the threshold is NOT stale. */
export function isStale(iso: string, thresholdDays: number, now: Date): boolean {
  return now.getTime() - new Date(iso).getTime() > thresholdDays * DAY_MS
}

export interface EvidenceSummary {
  state: EvidenceState
  /** When the evidence happened (backup / test / drill time). null = no evidence: unknown, not zero. */
  at: string | null
  ageDays: number | null
  thresholdDays: number
}
export interface Readiness {
  backup: EvidenceSummary & {
    backupId: string | null; type: BackupType | null
    /** Has THIS backup itself been restore-tested? null = no backup recorded. */
    verification: VerificationState | null
  }
  restoreVerification: EvidenceSummary & { backupId: string | null }
  drill: EvidenceSummary & { result: DrillResult | null }
  overall: { state: OverallState; reasons: string[]; notes: string[] }
}

const unknownEv = (thresholdDays: number): EvidenceSummary => ({ state: 'unknown', at: null, ageDays: null, thresholdDays })
const ev = (state: EvidenceState, at: string, thresholdDays: number, now: Date): EvidenceSummary =>
  ({ state, at, ageDays: ageDays(at, now), thresholdDays })

export function computeReadiness(
  data: Pick<Assembled, 'backups' | 'verifications' | 'drills'>, now: Date, t: Thresholds = STALENESS_DAYS,
): Readiness {
  // LATEST BACKUP = latest restore point, not latest typing time.
  const lb = data.backups[0] ?? null
  const backup: Readiness['backup'] = lb
    ? { ...ev(isStale(lb.backupAt, t.backup, now) ? 'stale' : 'current', lb.backupAt, t.backup, now),
        backupId: lb.id, type: lb.type, verification: lb.verification.state }
    : { ...unknownEv(t.backup), backupId: null, type: null, verification: null }

  // RESTORE VERIFICATION: newest test overall; a failure newer than the last pass is a failure.
  const newest = data.verifications[0] ?? null
  const lastPass = data.verifications.find(v => v.result === 'passed') ?? null
  let rv: Readiness['restoreVerification']
  if (!newest) rv = { ...unknownEv(t.restoreVerification), backupId: null }
  else if (newest.result === 'failed') rv = { ...ev('failed', newest.verifiedAt, t.restoreVerification, now), backupId: newest.backupId }
  else rv = { ...ev(isStale(lastPass!.verifiedAt, t.restoreVerification, now) ? 'stale' : 'current', lastPass!.verifiedAt, t.restoreVerification, now), backupId: lastPass!.backupId }

  const ld = data.drills[0] ?? null
  const drill: Readiness['drill'] = !ld
    ? { ...unknownEv(t.drill), result: null }
    : { ...ev(ld.result === 'failed' ? 'failed' : isStale(ld.drillAt, t.drill, now) ? 'stale' : 'current', ld.drillAt, t.drill, now), result: ld.result }

  // OVERALL: conservative. Every applicable problem is collected, then the WORST severity decides
  //   unknown (no backup)  >  failed  >  stale  >  recorded (incomplete)  >  verified
  // "verified" needs the LATEST BACKUP ITSELF to have a passing restore test: a pass on an older
  // backup is useful evidence (shown on its own card) but can never make this overall state green,
  // and it can never hide a failure of the latest backup.
  type Issue = { sev: 'failed' | 'stale' | 'recorded'; text: string }
  const issues: Issue[] = []
  const notes: string[] = []
  let state: OverallState
  const reasons: string[] = []
  if (!lb) {
    state = 'unknown'; reasons.push('No backup has been recorded, so backup readiness is unknown.')
  } else {
    const own = lb.verification
    // FAILED: any relevant failure. A failure is never downgraded by staleness or by a pass elsewhere.
    if (own.state === 'failed') issues.push({ sev: 'failed', text: 'The latest backup\u2019s own restore test failed.' })
    if (rv.state === 'failed' && rv.backupId !== lb.id) {
      issues.push({ sev: 'failed', text: 'The most recent restore test (of another recorded backup) failed.' })
    }
    if (drill.state === 'failed') issues.push({ sev: 'failed', text: 'The most recent DR drill failed.' })
    // STALE: required evidence older than its limit.
    if (backup.state === 'stale') issues.push({ sev: 'stale', text: `The latest recorded backup is older than ${t.backup} days.` })
    if (own.state === 'verified' && own.latest && isStale(own.latest.verifiedAt, t.restoreVerification, now)) {
      issues.push({ sev: 'stale', text: `The latest backup\u2019s passing restore test is older than ${t.restoreVerification} days.` })
    }
    if (drill.state === 'stale') issues.push({ sev: 'stale', text: `The latest DR drill is older than ${t.drill} days.` })
    // RECORDED: nothing wrong, but the evidence is incomplete.
    if (own.state === 'not_verified') {
      issues.push({ sev: 'recorded', text: 'The latest backup has not itself been restore-tested: a recorded backup is not a verified backup.' })
    }
    if (drill.state === 'unknown') issues.push({ sev: 'recorded', text: 'No DR drill has been recorded.' })
    if (drill.state === 'current' && drill.result === 'passed_with_issues') {
      issues.push({ sev: 'recorded', text: 'The latest DR drill passed with issues; resolve them and re-drill.' })
    }
    const has = (sev: Issue['sev']) => issues.some(i => i.sev === sev)
    state = has('failed') ? 'failed' : has('stale') ? 'stale' : has('recorded') ? 'recorded' : 'verified'
    for (const sev of ['failed', 'stale', 'recorded'] as const) for (const i of issues) if (i.sev === sev) reasons.push(i.text)
    if (rv.state !== 'unknown' && rv.backupId !== null && rv.backupId !== lb.id) {
      notes.push('The latest restore test applies to a different, older backup. It shows the restore procedure worked; it does not prove the latest backup restores.')
    }
  }
  return { backup, restoreVerification: rv, drill, overall: { state, reasons, notes } }
}

/** Plain-language labels, centralised so the UI cannot invent a friendlier word than the evidence supports. */
export const OVERALL_LABEL: Record<OverallState, string> = {
  verified: 'VERIFIED', recorded: 'RECORDED · NOT YET FULLY VERIFIED', stale: 'STALE', failed: 'FAILED', unknown: 'UNKNOWN · NOT RECORDED',
}
export const BACKUP_LABEL: Record<EvidenceState, string> = {
  current: 'RECORDED', stale: 'STALE', failed: 'FAILED', unknown: 'UNKNOWN · NOT RECORDED',
}
export const VERIFICATION_LABEL: Record<EvidenceState, string> = {
  current: 'VERIFIED', stale: 'STALE', failed: 'FAILED', unknown: 'UNKNOWN · NOT RECORDED',
}
export const DRILL_LABEL: Record<EvidenceState, string> = {
  current: 'RECORDED', stale: 'STALE', failed: 'FAILED', unknown: 'UNKNOWN · NOT RECORDED',
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD RESPONSE  (what the API returns; nothing else leaves the server)
// ─────────────────────────────────────────────────────────────────────────────

export interface BackupDashboard {
  generatedAt: string
  thresholds: Thresholds
  readiness: Readiness
  backups: BackupRecord[]
  drills: DrillRecord[]
  /** Counts of audit rows that looked like ours but were malformed/unassociated. Never their content. */
  ignored: Assembled['ignored']
}

export function buildDashboard(data: Assembled, now: Date, t: Thresholds = STALENESS_DAYS): BackupDashboard {
  return {
    generatedAt: now.toISOString(),
    thresholds: { ...t },
    readiness: computeReadiness(data, now, t),
    backups: data.backups.slice(0, LIMITS.historyShown),
    drills: data.drills.slice(0, LIMITS.historyShown),
    ignored: data.ignored,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE  (the only part that touches SQL)
// ─────────────────────────────────────────────────────────────────────────────

type SqlLike = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>
  query: (text: string, params?: unknown[]) => Promise<any>
}

const SELECT = `SELECT id::text AS id, actor_email, action, resource, resource_id, payload, created_at FROM admin_audit_logs`

export function createBackupService(sql: SqlLike, newId: () => string = () => crypto.randomUUID()) {
  const read = (action: string, resource: string, limit: number) =>
    sql.query(`${SELECT} WHERE action = $1 AND resource = $2 ORDER BY created_at DESC LIMIT $3`, [action, resource, limit]) as Promise<AuditRow[]>

  async function insert(actor: string, action: string, resource: string, id: string, resourceId: string, payload: object) {
    await sql.query(
      `INSERT INTO admin_audit_logs (id, actor_email, action, resource, resource_id, payload)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
      [id, actor, action, resource, resourceId, JSON.stringify(payload)])
  }

  return {
    /** Everything the page needs, from three bounded reads. */
    async getDashboard(now: Date = new Date()): Promise<BackupDashboard> {
      const [b, v, d] = await Promise.all([
        read(BACKUP_ACTION, BACKUP_RESOURCE, LIMITS.backupRowsRead),
        read(VERIFY_ACTION, BACKUP_RESOURCE, LIMITS.verificationRowsRead),
        read(DRILL_ACTION, DRILL_RESOURCE, LIMITS.drillRowsRead),
      ])
      return buildDashboard(assembleBackupData(b, v, d), now)
    },

    /** Append a backup record. Records metadata about a backup made elsewhere; creates nothing. */
    async recordBackup(input: BackupInput, actor: string): Promise<{ id: string }> {
      const id = newId()
      await insert(actor, BACKUP_ACTION, BACKUP_RESOURCE, id, id, { v: PAYLOAD_VERSION, ...input })
      return { id }
    },

    /**
     * Append a restore-test event for a backup that really is a recorded backup. Returns
     * 'not_found' when the id is not a valid backup record, 'before_backup' when the test is dated
     * before the backup it claims to test.
     */
    async recordVerification(input: VerificationInput, actor: string):
      Promise<{ ok: true; id: string } | { ok: false; reason: 'not_found' | 'before_backup' }> {
      const rows = await sql.query(
        `${SELECT} WHERE id = $1::uuid AND action = $2 AND resource = $3 LIMIT 1`,
        [input.backupId, BACKUP_ACTION, BACKUP_RESOURCE]) as AuditRow[]
      const target = assembleBackupData(rows, [], []).backups[0]
      if (!target) return { ok: false, reason: 'not_found' }
      if (input.verifiedAt < target.backupAt) return { ok: false, reason: 'before_backup' }
      const id = newId()
      await insert(actor, VERIFY_ACTION, BACKUP_RESOURCE, id, target.id, { v: PAYLOAD_VERSION, ...input, backupId: target.id })
      return { ok: true, id }
    },

    async recordDrill(input: DrillInput, actor: string): Promise<{ id: string }> {
      const id = newId()
      await insert(actor, DRILL_ACTION, DRILL_RESOURCE, id, id, { v: PAYLOAD_VERSION, ...input })
      return { id }
    },
  }
}
