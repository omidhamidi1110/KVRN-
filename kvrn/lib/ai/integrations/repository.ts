import { sql } from '@/lib/db'

const MAX_EXTERNAL_SNAPSHOT_BYTES = 2 * 1024 * 1024

function boundedSnapshotPayload(payload: Record<string, unknown>): string {
  let json: string
  try { json = JSON.stringify(payload) } catch { throw new Error('AI_EXTERNAL_SNAPSHOT_NOT_SERIALIZABLE') }
  if (new TextEncoder().encode(json).byteLength > MAX_EXTERNAL_SNAPSHOT_BYTES) {
    throw new Error('AI_EXTERNAL_SNAPSHOT_TOO_LARGE')
  }
  return json
}

export async function setIntegrationState(input: {
  id: string
  state: 'not_configured' | 'ready' | 'degraded' | 'failed' | 'disabled'
  errorCode?: string | null
  success?: boolean
  metadata?: Record<string, unknown>
  enabled?: boolean
}): Promise<void> {
  const changed = await sql`
    UPDATE ai_integrations SET
      enabled=COALESCE(${input.enabled ?? null}::boolean, enabled),
      connection_state=${input.state},
      last_success_at=CASE WHEN ${input.success ?? false} THEN NOW() ELSE last_success_at END,
      last_failure_at=CASE WHEN ${input.state === 'failed' || input.state === 'degraded'} THEN NOW() ELSE last_failure_at END,
      last_error_code=${input.errorCode ?? null},
      metadata=metadata || ${JSON.stringify(input.metadata ?? {})}::jsonb
    WHERE id=${input.id}
    RETURNING id
  ` as any[]
  // A successful evidence fetch does not mean the connector is Ready if its
  // state row was never provisioned (or was concurrently removed).
  if (!changed.length) throw new Error('AI_INTEGRATION_STATE_ROW_MISSING')
}

export async function recordExternalSnapshot(input: {
  integrationId: string
  dataset: string
  externalKey?: string
  periodStart?: string | null
  periodEnd?: string | null
  evidenceQuality?: 'known_fact' | 'observed' | 'calculated' | 'estimated' | 'unknown'
  payload: Record<string, unknown>
}): Promise<void> {
  const payload = boundedSnapshotPayload(input.payload)
  await sql`
    INSERT INTO ai_external_snapshots(
      integration_id,dataset,external_key,period_start,period_end,evidence_quality,payload,captured_at
    ) VALUES (
      ${input.integrationId},${input.dataset},${input.externalKey ?? 'aggregate'},
      ${input.periodStart ?? null}::date,${input.periodEnd ?? null}::date,
      ${input.evidenceQuality ?? 'observed'},${payload}::jsonb,NOW()
    )
    ON CONFLICT (integration_id,dataset,external_key,period_start,period_end)
    DO UPDATE SET captured_at=NOW(), evidence_quality=EXCLUDED.evidence_quality, payload=EXCLUDED.payload
  `
}

export async function latestExternalSnapshot(integrationId: string, dataset: string): Promise<any | null> {
  const rows = await sql`
    SELECT integration_id,dataset,external_key,period_start,period_end,captured_at,evidence_quality,payload
    FROM ai_external_snapshots WHERE integration_id=${integrationId} AND dataset=${dataset}
    ORDER BY captured_at DESC LIMIT 1
  ` as any[]
  return rows[0] ?? null
}

export type AiIntegrationState = {
  id: string
  department: string
  provider: string
  enabled: boolean
  connection_state: 'not_configured' | 'ready' | 'degraded' | 'failed' | 'disabled'
  last_success_at: string | null
  last_failure_at: string | null
  last_error_code: string | null
  metadata: Record<string, unknown>
  updated_at: string
}

export async function listIntegrationStates(): Promise<AiIntegrationState[]> {
  return await sql`
    SELECT id,department,provider,enabled,connection_state,last_success_at,last_failure_at,
           last_error_code,metadata,updated_at
    FROM ai_integrations
    ORDER BY department,id
  ` as AiIntegrationState[]
}
