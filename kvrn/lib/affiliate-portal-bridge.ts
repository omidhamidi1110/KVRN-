// lib/affiliate-portal-bridge.ts — the ONLY place the portal touches tables owned by the `affiliate-core`
// workstream (migration 033): affiliate_profiles, affiliate_documents, affiliate_acceptances.
//
// CONTRACT (see briefs/affcore.md). The portal READS profiles/documents/acceptances. It writes only:
//   * acceptance rows (+ the accepted_*_version / requires_reacceptance mirror on the profile), and
//   * the limited self-service fields display_name / website / social_links (design decision 3 "limited
//     contact/social edits"). Readiness columns, portal_access and paid_ads_policy are written ONLY through the
//     SQL functions in migration 034.
//
// If affiliate-core's lib/affiliate-program.ts `recordAcceptance()` is present at integration time, replace the
// body of `recordPortalAcceptance` with a call to it — it is isolated here for exactly that reason.
type Sql = any

export const REQUIRED_ACCEPTANCE_TYPES = ['program_terms', 'disclosure_policy'] as const
export const PORTAL_VISIBLE_DOCS = ['program_terms', 'disclosure_policy', 'privacy_notice', 'brand_rules'] as const
export type PortalDocType = typeof PORTAL_VISIBLE_DOCS[number]

export interface CurrentDocument {
  docType: string
  version: string
  title: string
  effectiveAt: string | null
  publishedAt: string | null
}

/** Latest PUBLISHED, EFFECTIVE version of each document type. */
export async function getCurrentDocuments(sql: Sql, withBody = false): Promise<Array<CurrentDocument & { body?: string }>> {
  const rows = await sql`
    SELECT DISTINCT ON (doc_type) doc_type, version::text AS version, title, body, effective_at, published_at
      FROM affiliate_documents
     WHERE published_at IS NOT NULL AND published_at <= NOW()
       AND (effective_at IS NULL OR effective_at <= NOW())
     ORDER BY doc_type, published_at DESC, id DESC` as any[]
  return rows.map(r => ({
    docType: r.doc_type, version: r.version, title: r.title,
    effectiveAt: r.effective_at ? new Date(r.effective_at).toISOString() : null,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    ...(withBody ? { body: String(r.body ?? '') } : {}),
  }))
}

export async function getCurrentDocumentBody(sql: Sql, docType: string):
  Promise<(CurrentDocument & { body: string }) | null> {
  const docs = await getCurrentDocuments(sql, true)
  return (docs.find(d => d.docType === docType) as any) ?? null
}

export interface ProfileRow {
  affiliateId: string
  programStatus: string
  kycStatus: string
  taxStatus: string
  payoutMethodStatus: string
  payoutProvider: string | null
  portalAccess: string
  paidAdsPolicy: string
  payoutThresholdCents: number | null
  payoutSchedule: string | null
  displayName: string | null
  website: string | null
  socialLinks: any[]
  country: string | null
  stateRegion: string | null
  acceptedProgramTermsVersion: string | null
  acceptedDisclosureVersion: string | null
  requiresReacceptance: boolean
  emailNormalized: string
}

export async function getProfileByAffiliateId(sql: Sql, affiliateId: string): Promise<ProfileRow | null> {
  const rows = await sql`
    SELECT affiliate_id, program_status, kyc_status, tax_status, payout_method_status, payout_provider,
           portal_access, paid_ads_policy, payout_threshold_cents, payout_schedule, display_name, website,
           social_links, country, state_region, accepted_program_terms_version, accepted_disclosure_version,
           requires_reacceptance, email_normalized
      FROM affiliate_profiles WHERE affiliate_id = ${affiliateId}::uuid` as any[]
  const r = rows[0]
  if (!r) return null
  return {
    affiliateId: r.affiliate_id, programStatus: r.program_status, kycStatus: r.kyc_status, taxStatus: r.tax_status,
    payoutMethodStatus: r.payout_method_status, payoutProvider: r.payout_provider ?? null,
    portalAccess: r.portal_access, paidAdsPolicy: r.paid_ads_policy,
    payoutThresholdCents: r.payout_threshold_cents === null ? null : Number(r.payout_threshold_cents),
    payoutSchedule: r.payout_schedule ?? null, displayName: r.display_name ?? null, website: r.website ?? null,
    socialLinks: Array.isArray(r.social_links) ? r.social_links : [],
    country: r.country ?? null, stateRegion: r.state_region ?? null,
    acceptedProgramTermsVersion: r.accepted_program_terms_version ?? null,
    acceptedDisclosureVersion: r.accepted_disclosure_version ?? null,
    requiresReacceptance: r.requires_reacceptance === true, emailNormalized: r.email_normalized,
  }
}

export interface AcceptanceState {
  docType: string
  currentVersion: string
  title: string
  acceptedVersion: string | null
  needsAcceptance: boolean
}

/** Per current document: which version this affiliate last accepted. Read-only. */
export async function getAcceptanceState(sql: Sql, affiliateId: string): Promise<AcceptanceState[]> {
  const docs = await getCurrentDocuments(sql)
  if (docs.length === 0) return []
  const acc = await sql`
    SELECT DISTINCT ON (doc_type) doc_type, version::text AS version
      FROM affiliate_acceptances
     WHERE affiliate_id = ${affiliateId}::uuid
     ORDER BY doc_type, accepted_at DESC, id DESC` as any[]
  const by = new Map<string, string>(acc.map(a => [a.doc_type as string, a.version as string]))
  return docs.map(d => {
    const accepted = by.get(d.docType) ?? null
    return { docType: d.docType, currentVersion: d.version, title: d.title, acceptedVersion: accepted, needsAcceptance: accepted !== d.version }
  })
}

/**
 * Record acceptance of the CURRENT version of the given document types, append-only (an accepted version is
 * never overwritten or replaced). Idempotent: accepting the same version twice adds no second row.
 * Mirrors accepted_program_terms_version / accepted_disclosure_version and clears requires_reacceptance when
 * every required document is current.
 */
export async function recordPortalAcceptance(
  sql: Sql, affiliateId: string, docTypes: string[], meta: { ipHash: string | null; uaHash: string | null },
): Promise<{ recorded: Array<{ docType: string; version: string }>; requiresReacceptance: boolean }> {
  const types = [...new Set(docTypes)].filter(t => (PORTAL_VISIBLE_DOCS as readonly string[]).includes(t))
  if (types.length === 0) return { recorded: [], requiresReacceptance: false }

  const rows = await sql`
    WITH cur AS (
      SELECT DISTINCT ON (doc_type) doc_type, version::text AS version
        FROM affiliate_documents
       WHERE published_at IS NOT NULL AND published_at <= NOW()
         AND (effective_at IS NULL OR effective_at <= NOW())
         AND doc_type = ANY(${types}::text[])
       ORDER BY doc_type, published_at DESC, id DESC
    ), ins AS (
      INSERT INTO affiliate_acceptances (affiliate_id, doc_type, version, accepted_at, ip_hash, user_agent_hash, method)
      SELECT ${affiliateId}::uuid, c.doc_type, c.version, NOW(), ${meta.ipHash}, ${meta.uaHash}, 'portal'
        FROM cur c
       WHERE NOT EXISTS (SELECT 1 FROM affiliate_acceptances x
                          WHERE x.affiliate_id = ${affiliateId}::uuid AND x.doc_type = c.doc_type AND x.version::text = c.version)
      ON CONFLICT DO NOTHING   -- a double click / retry racing this request must not fail
      RETURNING doc_type, version::text AS version
    ), upd AS (
      UPDATE affiliate_profiles
         SET accepted_program_terms_version = COALESCE((SELECT version FROM cur WHERE doc_type = 'program_terms'), accepted_program_terms_version),
             accepted_disclosure_version    = COALESCE((SELECT version FROM cur WHERE doc_type = 'disclosure_policy'), accepted_disclosure_version),
             updated_at = NOW()
       WHERE affiliate_id = ${affiliateId}::uuid
       RETURNING 1
    )
    SELECT doc_type, version FROM cur` as any[]

  // Clear the flag only when NOTHING required is outstanding any more.
  await sql`
    UPDATE affiliate_profiles p
       SET requires_reacceptance = FALSE, updated_at = NOW()
     WHERE p.affiliate_id = ${affiliateId}::uuid AND p.requires_reacceptance
       AND NOT EXISTS (
         SELECT 1 FROM (
           SELECT DISTINCT ON (doc_type) doc_type, version::text AS version
             FROM affiliate_documents
            WHERE published_at IS NOT NULL AND published_at <= NOW() AND (effective_at IS NULL OR effective_at <= NOW())
              AND doc_type IN ('program_terms','disclosure_policy')
            ORDER BY doc_type, published_at DESC, id DESC) d
         WHERE NOT EXISTS (SELECT 1 FROM affiliate_acceptances a
                            WHERE a.affiliate_id = p.affiliate_id AND a.doc_type = d.doc_type AND a.version::text = d.version))`
  await sql`INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
            VALUES (${affiliateId}::uuid, 'terms_accepted', ${JSON.stringify({ docTypes: types })}::jsonb)`

  const flag = await sql`SELECT requires_reacceptance FROM affiliate_profiles WHERE affiliate_id = ${affiliateId}::uuid` as any[]
  return {
    recorded: rows.map(r => ({ docType: r.doc_type as string, version: r.version as string })),
    requiresReacceptance: flag[0]?.requires_reacceptance === true,
  }
}

/** Limited self-service profile fields. Values must already be validated (lib/affiliate-portal-validation.ts). */
export async function updateOwnProfileFields(
  sql: Sql, affiliateId: string,
  patch: { displayName?: string | null; website?: string | null; socialLinks?: Array<{ platform: string; url: string }> },
): Promise<string[]> {
  const sets: string[] = []
  if (patch.displayName !== undefined) sets.push('displayName')
  if (patch.website !== undefined) sets.push('website')
  if (patch.socialLinks !== undefined) sets.push('socialLinks')
  if (sets.length === 0) return []
  await sql`
    UPDATE affiliate_profiles
       SET display_name = CASE WHEN ${patch.displayName !== undefined} THEN ${patch.displayName ?? null} ELSE display_name END,
           website      = CASE WHEN ${patch.website !== undefined} THEN ${patch.website ?? null} ELSE website END,
           social_links = CASE WHEN ${patch.socialLinks !== undefined} THEN ${JSON.stringify(patch.socialLinks ?? [])}::jsonb ELSE social_links END,
           updated_at = NOW()
     WHERE affiliate_id = ${affiliateId}::uuid`
  await sql`INSERT INTO affiliate_security_events (affiliate_id, event_type, detail)
            VALUES (${affiliateId}::uuid, 'profile_updated', ${JSON.stringify({ fields: sets })}::jsonb)`
  return sets
}
