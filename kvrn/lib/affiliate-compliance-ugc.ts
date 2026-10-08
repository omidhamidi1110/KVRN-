// lib/affiliate-compliance-ugc.ts — UGC / creator content rights, kept SEPARATE from affiliate status.
// Server-only.
//
// Being an affiliate, receiving product, or posting about KVRN grants NO right to reuse the content. A right exists
// only as an explicit Admin-recorded license (affiliate_ugc_licenses). Licenses are immutable evidence: they can be
// revoked (one-way) but never edited. Evidence is a REFERENCE to where the signed agreement lives, never a file.
type Sql = any

export const UGC_RIGHTS = ['organic', 'website', 'email', 'paid_ads', 'whitelisting', 'editing', 'likeness'] as const
export type UgcRight = typeof UGC_RIGHTS[number]
export const UGC_CHANNELS = ['instagram', 'tiktok', 'youtube', 'facebook', 'x', 'pinterest', 'website', 'email', 'paid_social', 'other'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface UgcGrantInput {
  licenseVersion: string
  rights: Partial<Record<UgcRight, boolean>>
  channels: string[]
  territory: string
  durationMonths: number | null
  startsAt: string
  expiresAt: string | null
  compensationNote: string | null
  evidenceRef: string | null
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }
const trimOrNull = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > max ? undefined : (t || null)
}

export function validateUgcGrant(b: any, now: Date = new Date()): Result<UgcGrantInput> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'Invalid request.' }
  const licenseVersion = typeof b.licenseVersion === 'string' ? b.licenseVersion.trim() : ''
  if (licenseVersion.length < 1 || licenseVersion.length > 40) return { ok: false, error: 'Enter the license version (for example "v1").' }

  const rights: Partial<Record<UgcRight, boolean>> = {}
  if (!b.rights || typeof b.rights !== 'object' || Array.isArray(b.rights)) return { ok: false, error: 'Choose at least one right to grant.' }
  for (const [k, v] of Object.entries(b.rights)) {
    if (!(UGC_RIGHTS as readonly string[]).includes(k)) return { ok: false, error: `Unknown right "${String(k).slice(0, 30)}".` }
    if (typeof v !== 'boolean') return { ok: false, error: 'Each right must be on or off.' }
    rights[k as UgcRight] = v
  }
  if (!Object.values(rights).some(v => v === true)) return { ok: false, error: 'Choose at least one right to grant.' }

  const channels = Array.isArray(b.channels) ? b.channels : []
  if (channels.length > 12 || channels.some((c: unknown) => typeof c !== 'string' || !(UGC_CHANNELS as readonly string[]).includes(c))) {
    return { ok: false, error: 'Unknown channel.' }
  }
  const territory = typeof b.territory === 'string' ? b.territory.trim() : ''
  if (territory.length < 2 || territory.length > 80) return { ok: false, error: 'Enter the territory (for example "Worldwide").' }

  let durationMonths: number | null = null
  if (b.durationMonths !== undefined && b.durationMonths !== null && b.durationMonths !== '') {
    const d = Number(b.durationMonths)
    if (!Number.isInteger(d) || d < 1 || d > 600) return { ok: false, error: 'Duration must be 1–600 months.' }
    durationMonths = d
  }
  const startsAtD = new Date(b.startsAt ?? now.toISOString())
  if (Number.isNaN(startsAtD.getTime())) return { ok: false, error: 'Start date is not valid.' }
  let expiresAt: string | null = null
  if (b.expiresAt) {
    const e = new Date(b.expiresAt)
    if (Number.isNaN(e.getTime()) || e <= startsAtD) return { ok: false, error: 'Expiry must be after the start date.' }
    expiresAt = e.toISOString()
  } else if (durationMonths) {
    const e = new Date(startsAtD); e.setUTCMonth(e.getUTCMonth() + durationMonths); expiresAt = e.toISOString()
  }
  const compensationNote = trimOrNull(b.compensationNote, 500)
  const evidenceRef = trimOrNull(b.evidenceRef, 200)
  if (compensationNote === undefined) return { ok: false, error: 'Compensation note is too long (500 max).' }
  if (evidenceRef === undefined) return { ok: false, error: 'Agreement reference is too long (200 max).' }
  // Rights that reach beyond organic reposting must point at the signed agreement.
  const broad = rights.paid_ads || rights.whitelisting || rights.likeness
  if (broad && !evidenceRef) return { ok: false, error: 'Paid ads, whitelisting and likeness rights need a reference to the signed agreement.' }

  return { ok: true, value: { licenseVersion, rights, channels, territory, durationMonths, startsAt: startsAtD.toISOString(), expiresAt, compensationNote, evidenceRef } }
}

export function mapUgcError(err: unknown): { status: number; message: string } | null {
  const msg = String((err as any)?.message ?? '')
  if (msg.includes('LICENSE_FINAL')) return { status: 409, message: 'That license is already revoked.' }
  if (msg.includes('LICENSE_IMMUTABLE')) return { status: 409, message: 'A license cannot be edited. Revoke it and record a new one.' }
  if (msg.includes('affiliate_ugc_licenses_rights_check') || msg.includes('aul_')) return { status: 400, message: 'Those license terms are not valid.' }
  if (msg.includes('affiliate_ugc_licenses_affiliate_id_fkey')) return { status: 404, message: 'Affiliate not found.' }
  return null
}

export function createAffiliateUgcService(sql: Sql) {
  return {
    async list(affiliateId: string) {
      if (!UUID_RE.test(affiliateId)) return []
      const rows = await sql`
        SELECT id, license_version, rights, channels, territory, duration_months, starts_at, expires_at,
               compensation_note, evidence_ref, granted_at, granted_by, revoked_at, revoked_by, revoke_reason,
               (revoked_at IS NULL AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS active
          FROM affiliate_ugc_licenses WHERE affiliate_id = ${affiliateId}::uuid ORDER BY granted_at DESC LIMIT 50` as any[]
      return rows.map(r => ({
        id: r.id as string, licenseVersion: r.license_version as string, rights: r.rights as Record<string, boolean>,
        channels: (r.channels ?? []) as string[], territory: r.territory as string, durationMonths: r.duration_months === null ? null : Number(r.duration_months),
        startsAt: new Date(r.starts_at).toISOString(), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        compensationNote: r.compensation_note ?? null, evidenceRef: r.evidence_ref ?? null,
        grantedAt: new Date(r.granted_at).toISOString(), grantedBy: r.granted_by as string,
        revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null, revokedBy: r.revoked_by ?? null,
        revokeReason: r.revoke_reason ?? null, active: r.active === true,
      }))
    },

    /** Grant + audit in ONE statement, so a license can never exist without its audit row. */
    async grant(affiliateId: string, v: UgcGrantInput, actor: string): Promise<{ id: string }> {
      const rows = await sql`
        WITH ins AS (
          INSERT INTO affiliate_ugc_licenses
            (affiliate_id, license_version, rights, channels, territory, duration_months, starts_at, expires_at,
             compensation_note, evidence_ref, granted_by)
          VALUES (${affiliateId}::uuid, ${v.licenseVersion}, ${JSON.stringify(v.rights)}::jsonb, ${v.channels}::text[], ${v.territory},
                  ${v.durationMonths}, ${v.startsAt}::timestamptz, ${v.expiresAt}::timestamptz,
                  ${v.compensationNote}, ${v.evidenceRef}, ${actor})
          RETURNING id, rights)
        , aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.ugc_license_granted', 'affiliates', ${affiliateId}::text,
                 jsonb_build_object('license_id', ins.id, 'version', ${v.licenseVersion}::text, 'rights', ins.rights, 'territory', ${v.territory}::text)
            FROM ins)
        SELECT id FROM ins` as any[]
      return { id: rows[0].id as string }
    },

    /** One-way. The row is never edited otherwise (DB guard). */
    async revoke(affiliateId: string, licenseId: string, reason: string, actor: string): Promise<boolean> {
      if (!UUID_RE.test(licenseId)) return false
      const why = String(reason ?? '').trim().slice(0, 300)
      if (why.length < 3) throw Object.assign(new Error('REASON_REQUIRED'), { code: 'REASON_REQUIRED' })
      const rows = await sql`
        WITH upd AS (
          UPDATE affiliate_ugc_licenses SET revoked_at = NOW(), revoked_by = ${actor}, revoke_reason = ${why}
           WHERE id = ${licenseId}::uuid AND affiliate_id = ${affiliateId}::uuid AND revoked_at IS NULL
           RETURNING id)
        , aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.ugc_license_revoked', 'affiliates', ${affiliateId}::text,
                 jsonb_build_object('license_id', upd.id, 'reason', ${why}::text) FROM upd)
        SELECT id FROM upd` as any[]
      return rows.length > 0
    },

    /** Is this specific right currently granted? FALSE for every affiliate without a license. */
    async rightActive(affiliateId: string, right: UgcRight, at?: Date): Promise<boolean> {
      if (!UUID_RE.test(affiliateId) || !(UGC_RIGHTS as readonly string[]).includes(right)) return false
      // "Now" is the DATABASE clock (a JS timestamp truncated to milliseconds could sort before a revocation made in
      // the same millisecond). An explicit `at` is for point-in-time questions only.
      const rows = (at
        ? await sql`SELECT affiliate_ugc_right_active(${affiliateId}::uuid, ${right}, ${at.toISOString()}::timestamptz) AS ok`
        : await sql`SELECT affiliate_ugc_right_active(${affiliateId}::uuid, ${right}) AS ok`) as any[]
      return rows[0]?.ok === true
    },
  }
}

export type AffiliateUgcService = ReturnType<typeof createAffiliateUgcService>
