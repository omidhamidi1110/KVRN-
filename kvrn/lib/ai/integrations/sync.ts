import { createAiAction, getAiRuntimeSettings, markAiAction, upsertAiAlert, resolveAiAlertsByDedupePrefix } from '../repository'
import { errorCode } from './http'
import { setIntegrationState } from './repository'
import { syncGoogleMerchant, syncGoogleSearchConsole } from './google'
import { syncTikTokAds } from './tiktok'
import { syncMetaAds } from './meta'
import type { AiAgentId } from '../types'

type IntegrationId = 'meta' | 'tiktok' | 'google_search_console' | 'google_merchant'

const RUNNERS: Record<IntegrationId, (timezone: string) => Promise<{ skipped?: string; rows?: number }>> = {
  meta: syncMetaAds,
  tiktok: syncTikTokAds,
  google_search_console: syncGoogleSearchConsole,
  google_merchant: syncGoogleMerchant,
}

const OWNER: Record<IntegrationId, AiAgentId> = {
  meta: 'ads_social', tiktok: 'ads_social',
  google_search_console: 'seo_commerce_data', google_merchant: 'seo_commerce_data',
}

export async function handleExternalIntegrationSync(event: { id: string; payload?: Record<string, unknown> }): Promise<void> {
  const integrationId = String(event.payload?.integrationId ?? '') as IntegrationId
  const runner = RUNNERS[integrationId]
  if (!runner) throw Object.assign(new Error('AI_INTEGRATION_UNSUPPORTED'), { nonRetryable: true })
  const agentId = OWNER[integrationId]
  const actionId = await createAiAction({
    agentId, eventId:event.id, actionType:'external_data_sync', resource:'ai_integration', resourceId:integrationId,
    summary:`Sync ${integrationId} external evidence.`, permissionLevel:'green', riskLevel:'info', status:'running',
    ownerVisible:false, idempotencyKey:`external-sync-action:${event.id}`,
  })
  // A retry reuses the idempotent action row. Reopen it explicitly so the action
  // state reflects the in-flight attempt instead of retaining the prior failure.
  await markAiAction({ actionId, status:'running', completed:false, outcome:{ retrying:false } })
  if (process.env.AI_EXTERNAL_SYNC_ENABLED !== 'true') {
    await markAiAction({ actionId, status:'skipped', completed:true, outcome:{ code:'EXTERNAL_SYNC_DISABLED' } })
    return
  }
  try {
    const settings = await getAiRuntimeSettings().catch(() => null)
    const timezone = settings?.businessTimezone ?? process.env.AI_BUSINESS_TIMEZONE ?? 'America/Los_Angeles'
    const result = await runner(timezone)
    if (result.skipped) {
      await setIntegrationState({ id:integrationId, state:'not_configured', errorCode:null, enabled:false })
      await resolveAiAlertsByDedupePrefix({ sourceAgentId:agentId, prefix:`integration-sync:${integrationId}`, note:'Integration is no longer configured, so its prior sync failure is no longer active.' })
      await markAiAction({ actionId, status:'skipped', completed:true, outcome:{ code:result.skipped } })
      return
    }
    await resolveAiAlertsByDedupePrefix({ sourceAgentId:agentId, prefix:`integration-sync:${integrationId}`, note:'External evidence sync succeeded again.' })
    await markAiAction({ actionId, status:'succeeded', completed:true, outcome:{ rows:result.rows ?? 0 } })
  } catch (error) {
    const code = errorCode(integrationId, error)
    await setIntegrationState({ id:integrationId, state:'failed', errorCode:code, enabled:true })
    await upsertAiAlert({
      sourceAgentId:agentId, actionId, severity:'medium', category:'provider_failure',
      title:`${integrationId.replaceAll('_',' ')} sync failed`,
      summary:`External data sync failed with ${code}. KVRN canonical commerce data is unaffected.`,
      dedupeKey:`integration-sync:${integrationId}`, metadata:{ integrationId, code, requiresOwner:false },
    })
    // External evidence fetches are non-AI and intentionally retryable. Mark that
    // explicitly so queue crash-recovery does not confuse this completed attempt
    // with a terminal paid/manual failure that must never replay automatically.
    await markAiAction({ actionId, status:'failed', completed:true, outcome:{ code, retryable:true } })
    throw error
  }
}
