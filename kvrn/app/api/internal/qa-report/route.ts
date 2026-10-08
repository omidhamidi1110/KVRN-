import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { upsertAiAlert } from '@/lib/ai/repository'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_BODY_BYTES = 512 * 1024
const MAX_EVIDENCE_BYTES = 20 * 1024

function boundedEvidence(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  try {
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).byteLength <= MAX_EVIDENCE_BYTES) return value as Record<string, unknown>
    return { truncated: true, reason: 'QA_EVIDENCE_TOO_LARGE' }
  } catch {
    return { truncated: true, reason: 'QA_EVIDENCE_UNSERIALIZABLE' }
  }
}

function safeEqual(a: string, b: string): boolean {
  let r = a.length === b.length ? 0 : 1
  const n = Math.max(a.length, b.length)
  for (let i=0;i<n;i++) r |= (a.charCodeAt(i % Math.max(1,a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1,b.length)) || 0)
  return r === 0
}

export async function POST(req: NextRequest) {
  const secret = process.env.QA_REPORT_SECRET ?? ''
  if (!secret || (process.env.NODE_ENV === 'production' && secret.trim().length < 32)) return NextResponse.json({ error: 'QA reporting not configured.' }, { status: 503, headers: NO_STORE })
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  const advertisedLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'QA report too large.' }, { status: 413, headers: NO_STORE })
  }
  let body: any
  try {
    const raw = await req.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'QA report too large.' }, { status: 413, headers: NO_STORE })
    }
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400, headers: NO_STORE })
  }
  const trigger = ['development','pre_merge','post_deploy','scheduled','manual'].includes(body?.triggerType) ? body.triggerType : 'post_deploy'
  const environment = ['local','test','preview','production'].includes(body?.environment) ? body.environment : 'production'
  const status = ['passed','failed','degraded','cancelled'].includes(body?.status) ? body.status : null
  if (!status) return NextResponse.json({ error: 'Invalid status.' }, { status: 400, headers: NO_STORE })

  const count = (value: unknown): number | null => {
    const n = Number(value ?? 0)
    return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null
  }
  const total = count(body?.totalCount)
  const passed = count(body?.passedCount)
  const failed = count(body?.failedCount)
  const skipped = count(body?.skippedCount)
  if (total === null || passed === null || failed === null || skipped === null || passed + failed + skipped > total) {
    return NextResponse.json({ error: 'Invalid QA counts.' }, { status: 400, headers: NO_STORE })
  }
  const commit = typeof body?.commitSha === 'string' ? body.commitSha.slice(0, 80) : null

  // Validate every supplied test id before creating the run. This keeps a malformed
  // CI report from leaving a durable run row with only a partial result set.
  const rawResults = Array.isArray(body?.results) ? body.results.slice(0, 200) : []
  const normalizedResults: Array<{ testCaseId:string; status:'passed'|'failed'|'skipped'; durationMs:number|null; failureCode:string|null; diagnostic:string|null; evidence:Record<string,unknown> }> = []
  for (const item of rawResults) {
    const testCaseId = typeof item?.testCaseId === 'string' ? item.testCaseId.slice(0, 120) : ''
    const itemStatus = ['passed','failed','skipped'].includes(item?.status) ? item.status as 'passed'|'failed'|'skipped' : null
    if (!testCaseId || !itemStatus) return NextResponse.json({ error:'Invalid QA test result.' }, { status:400, headers:NO_STORE })
    const durationRaw = item?.durationMs == null ? null : Number(item.durationMs)
    const durationMs = durationRaw == null ? null : Number.isFinite(durationRaw) && durationRaw >= 0 && durationRaw <= 86_400_000 ? Math.floor(durationRaw) : null
    if (item?.durationMs != null && durationMs === null) return NextResponse.json({ error:'Invalid QA duration.' }, { status:400, headers:NO_STORE })
    normalizedResults.push({
      testCaseId, status:itemStatus,
      durationMs,
      failureCode:typeof item?.failureCode === 'string' ? item.failureCode.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 100) : null,
      diagnostic:typeof item?.diagnosticSummary === 'string' ? item.diagnosticSummary.slice(0, 1000) : null,
      evidence:boundedEvidence(item?.evidence),
    })
  }
  if (normalizedResults.length) {
    const ids = normalizedResults.map(r => r.testCaseId)
    const idsJson = JSON.stringify(ids)
    const known = await sql`
      SELECT id FROM qa_test_cases
      WHERE id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))
    ` as any[]
    const knownIds = new Set(known.map(r => String(r.id)))
    const unknown = ids.find(id => !knownIds.has(id))
    if (unknown) return NextResponse.json({ error:'Unknown QA test case.' }, { status:400, headers:NO_STORE })
  }

  try {
    const rows = await sql`
      INSERT INTO qa_test_runs(trigger_type, environment, commit_sha, status, total_count, passed_count, failed_count, skipped_count, completed_at)
      VALUES (${trigger}, ${environment}, ${commit}, ${status}, ${total}, ${passed}, ${failed}, ${skipped}, NOW())
      RETURNING id
    ` as any[]
    const runId = String(rows[0]?.id ?? '')

    // Optional per-contract results let the dashboard know exactly which durable feature was verified.
    // Unknown test ids are rejected by the FK and make this report fail rather than creating fake QA coverage.
    for (const item of normalizedResults) {
      await sql`
        INSERT INTO qa_test_results(run_id, test_case_id, status, duration_ms, failure_code, diagnostic_summary, evidence)
        VALUES (${runId}::uuid, ${item.testCaseId}, ${item.status}, ${item.durationMs}, ${item.failureCode}, ${item.diagnostic}, ${JSON.stringify(item.evidence)}::jsonb)
        ON CONFLICT (run_id, test_case_id) DO NOTHING
      `
    }
    if (rawResults.length > 0) {
      await sql`
        UPDATE qa_features f SET
          last_passed_at = CASE WHEN x.any_passed AND NOT x.any_failed THEN NOW() ELSE f.last_passed_at END,
          last_failed_at = CASE WHEN x.any_failed THEN NOW() ELSE f.last_failed_at END
        FROM (
          SELECT tc.feature_id,
                 bool_or(r.status='passed') AS any_passed,
                 bool_or(r.status='failed') AS any_failed
          FROM qa_test_results r
          JOIN qa_test_cases tc ON tc.id=r.test_case_id
          WHERE r.run_id=${runId}::uuid
          GROUP BY tc.feature_id
        ) x
        WHERE f.id=x.feature_id
      `
    }

    if (status === 'failed') {
      await upsertAiAlert({
        sourceAgentId: 'engineering_qa',
        severity: environment === 'production' ? 'critical' : 'high',
        category: 'qa_regression',
        title: environment === 'production' ? 'Production regression detected' : 'Regression suite failed',
        summary: `${failed} of ${total} automated QA checks failed${commit ? ` at ${commit.slice(0, 12)}` : ''}.`,
        dedupeKey: `qa:${environment}:${commit || runId}`,
        metadata: { requiresOwner: environment === 'production', runId: runId || null },
      })
    }
    return NextResponse.json({ ok: true, runId: runId || null }, { headers: NO_STORE })
  } catch (err: any) {
    console.error('[qa-report] failed:', String(err?.message ?? err).slice(0,100))
    return NextResponse.json({ error: 'QA report failed.' }, { status: 500, headers: NO_STORE })
  }
}
