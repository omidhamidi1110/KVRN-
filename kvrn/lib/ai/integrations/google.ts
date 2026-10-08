import { integrationFetch, jsonOrThrow, dateRange } from './http'
import { recordExternalSnapshot, setIntegrationState } from './repository'

async function googleAccessToken(preferred?: string): Promise<string> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim()
  // Refresh credentials are authoritative when available. A copied access token can
  // expire silently; preferring the refresh flow keeps unattended syncs durable.
  if (!clientId || !clientSecret || !refreshToken) {
    if (preferred?.trim()) return preferred.trim()
    throw new Error('GOOGLE_OAUTH_NOT_CONFIGURED')
  }
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  const res = await integrationFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  const json = await jsonOrThrow(res, 'GOOGLE_OAUTH')
  if (!json.access_token) throw new Error('GOOGLE_OAUTH_NO_ACCESS_TOKEN')
  return String(json.access_token)
}

async function googlePost(url: string, token: string, body: Record<string, unknown>): Promise<any> {
  const res = await integrationFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return jsonOrThrow(res, 'GOOGLE')
}

async function merchantReportAll(url: string, token: string, query: string): Promise<any[]> {
  const results: any[] = []
  let pageToken: string | undefined
  const maxPages = 10
  const pageSize = 1000
  for (let page=0; page<maxPages; page++) {
    const response = await googlePost(url, token, { query, pageSize, ...(pageToken ? { pageToken } : {}) })
    if (Array.isArray(response.results)) results.push(...response.results)
    const next = typeof response.nextPageToken === 'string' && response.nextPageToken.trim() ? response.nextPageToken.trim() : undefined
    if (!next) return results
    pageToken = next
  }
  // Never persist/interpret a partial Merchant dataset as complete.
  throw new Error('GOOGLE_MERCHANT_PAGINATION_LIMIT')
}

export async function syncGoogleSearchConsole(timezone = 'America/Los_Angeles'): Promise<{ skipped?: string; rows?: number }> {
  const site = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL?.trim()
  const staticToken = process.env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN?.trim()
  if (!site || (!staticToken && !process.env.GOOGLE_OAUTH_REFRESH_TOKEN)) return { skipped: 'NOT_CONFIGURED' }
  const token = await googleAccessToken(staticToken)
  // Search Console final data commonly lags. Use a 3-day buffer for unattended decisions.
  const { startDate, endDate } = dateRange(7, 3, timezone)
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`
  const [daily, queries, pages] = await Promise.all([
    googlePost(base, token, { startDate, endDate, dimensions: ['date'], rowLimit: 1000, dataState: 'final' }),
    googlePost(base, token, { startDate, endDate, dimensions: ['query'], rowLimit: 100, dataState: 'final' }),
    googlePost(base, token, { startDate, endDate, dimensions: ['page'], rowLimit: 100, dataState: 'final' }),
  ])
  await Promise.all([
    recordExternalSnapshot({ integrationId:'google_search_console', dataset:'search_daily', periodStart:startDate, periodEnd:endDate, payload:{ rows: daily.rows ?? [], aggregationType: daily.responseAggregationType ?? null } }),
    recordExternalSnapshot({ integrationId:'google_search_console', dataset:'top_queries', periodStart:startDate, periodEnd:endDate, payload:{ rows: queries.rows ?? [] } }),
    recordExternalSnapshot({ integrationId:'google_search_console', dataset:'top_pages', periodStart:startDate, periodEnd:endDate, payload:{ rows: pages.rows ?? [] } }),
  ])
  await setIntegrationState({ id:'google_search_console', state:'ready', success:true, enabled:true, metadata:{ lastRange:{startDate,endDate} } })
  return { rows: Number(daily.rows?.length ?? 0) + Number(queries.rows?.length ?? 0) + Number(pages.rows?.length ?? 0) }
}

export async function syncGoogleMerchant(timezone = 'America/Los_Angeles'): Promise<{ skipped?: string; rows?: number }> {
  const accountId = process.env.GOOGLE_MERCHANT_ACCOUNT_ID?.trim()
  const staticToken = process.env.GOOGLE_MERCHANT_ACCESS_TOKEN?.trim()
  if (!accountId || (!staticToken && !process.env.GOOGLE_OAUTH_REFRESH_TOKEN)) return { skipped: 'NOT_CONFIGURED' }
  const token = await googleAccessToken(staticToken)
  const { startDate, endDate } = dateRange(7, 1, timezone)
  const url = `https://merchantapi.googleapis.com/reports/v1/accounts/${encodeURIComponent(accountId)}/reports:search`
  const perfQuery = `SELECT clicks, impressions FROM product_performance_view WHERE date BETWEEN '${startDate}' AND '${endDate}'`
  const issuesQuery = "SELECT id, offer_id, feed_label, title, aggregated_reporting_context_status, item_issues FROM product_view WHERE aggregated_reporting_context_status = 'NOT_ELIGIBLE_OR_DISAPPROVED'"
  const [performanceResults, issueResults] = await Promise.all([
    merchantReportAll(url, token, perfQuery),
    merchantReportAll(url, token, issuesQuery),
  ])
  await Promise.all([
    recordExternalSnapshot({ integrationId:'google_merchant', dataset:'performance', periodStart:startDate, periodEnd:endDate, payload:{ results: performanceResults } }),
    recordExternalSnapshot({ integrationId:'google_merchant', dataset:'product_issues', externalKey:'current', periodStart:endDate, periodEnd:endDate, payload:{ results: issueResults } }),
  ])
  await setIntegrationState({ id:'google_merchant', state:'ready', success:true, enabled:true, metadata:{ lastRange:{startDate,endDate}, complete:true } })
  return { rows: performanceResults.length + issueResults.length }
}
