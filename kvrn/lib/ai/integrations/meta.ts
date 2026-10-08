import { integrationFetch, jsonOrThrow, dateRange } from './http'
import { recordExternalSnapshot, setIntegrationState } from './repository'

const MAX_PAGES = 10

export async function syncMetaAds(timezone = 'America/Los_Angeles'): Promise<{ skipped?: string; rows?: number }> {
  const token = process.env.META_ACCESS_TOKEN?.trim()
  const account = process.env.META_AD_ACCOUNT_ID?.trim()?.replace(/^act_/, '')
  const version = process.env.META_GRAPH_API_VERSION?.trim()
  if (!token || !account) return { skipped: 'NOT_CONFIGURED' }
  // Intentionally require an explicit Graph version so a future Meta version sunset
  // cannot silently change KVRN behavior behind a hard-coded version.
  if (!version || !/^v\d+\.\d+$/.test(version)) throw new Error('META_GRAPH_API_VERSION_REQUIRED')
  const { startDate, endDate } = dateRange(7, 0, timezone)
  const baseParams = new URLSearchParams({
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
    time_range: JSON.stringify({ since:startDate, until:endDate }),
    time_increment: '1',
    limit: '500',
  })

  // Never put the access token in the query string. Query URLs are more likely than
  // headers to appear in reverse-proxy/debug logs.
  const rows: any[] = []
  let after: string | null = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams(baseParams)
    if (after) params.set('after', after)
    const res = await integrationFetch(`https://graph.facebook.com/${version}/act_${encodeURIComponent(account)}/insights?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    const json = await jsonOrThrow(res, 'META')
    const pageRows = Array.isArray(json.data) ? json.data : []
    rows.push(...pageRows)
    const nextAfter = typeof json?.paging?.cursors?.after === 'string' && json.paging.cursors.after.trim()
      ? json.paging.cursors.after.trim() : null
    const hasNext = Boolean(json?.paging?.next)
    if (!hasNext) {
      after = null
      break
    }
    if (!nextAfter) throw new Error('META_PAGINATION_CURSOR_MISSING')
    if (page === MAX_PAGES) throw new Error('META_PAGINATION_LIMIT')
    after = nextAfter
  }

  // Evidence must be durable before the integration can become Ready. Keeping
  // the state write sequential prevents a failed snapshot and a concurrent Ready
  // update from racing and leaving the dashboard falsely green.
  await recordExternalSnapshot({ integrationId:'meta', dataset:'ads_performance', periodStart:startDate, periodEnd:endDate, payload:{ rows } })
  await setIntegrationState({ id:'meta', state:'ready', success:true, enabled:true, metadata:{ graphVersion:version, lastRange:{startDate,endDate}, rows:rows.length } })
  return { rows: rows.length }
}
