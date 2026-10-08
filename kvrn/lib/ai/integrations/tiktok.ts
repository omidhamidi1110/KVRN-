import { integrationFetch, jsonOrThrow, dateRange } from './http'
import { recordExternalSnapshot, setIntegrationState } from './repository'

const MAX_PAGES = 10
const PAGE_SIZE = 1000

export async function syncTikTokAds(timezone = 'America/Los_Angeles'): Promise<{ skipped?: string; rows?: number }> {
  const token = process.env.TIKTOK_ACCESS_TOKEN?.trim()
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID?.trim()
  if (!token || !advertiserId) return { skipped: 'NOT_CONFIGURED' }
  const { startDate, endDate } = dateRange(7, 0, timezone)
  const baseParams = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: 'BASIC',
    data_level: 'AUCTION_ADVERTISER',
    dimensions: JSON.stringify(['stat_time_day']),
    metrics: JSON.stringify(['spend','impressions','clicks','conversion','cost_per_conversion']),
    start_date: startDate,
    end_date: endDate,
    page_size: String(PAGE_SIZE),
  })

  const rows: any[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams(baseParams)
    params.set('page', String(page))
    const res = await integrationFetch(`https://business-api.tiktok.com/open_api/v2.0/report/integrated/get/?${params.toString()}`, {
      headers: { 'Access-Token': token, Accept: 'application/json' },
    })
    const json = await jsonOrThrow(res, 'TIKTOK')
    if (Number(json.code ?? 0) !== 0) throw new Error(`TIKTOK_API_${String(json.code ?? 'UNKNOWN')}`)
    const pageRows = Array.isArray(json?.data?.list) ? json.data.list : []
    rows.push(...pageRows)

    const info = json?.data?.page_info ?? {}
    const totalPages = Number(info.total_page ?? info.total_pages ?? 0)
    const totalNumber = Number(info.total_number ?? info.total_count ?? 0)
    const knownDone = Number.isFinite(totalPages) && totalPages > 0
      ? page >= totalPages
      : Number.isFinite(totalNumber) && totalNumber >= 0
        ? rows.length >= totalNumber
        : pageRows.length < PAGE_SIZE
    if (knownDone) break
    if (page === MAX_PAGES) throw new Error('TIKTOK_PAGINATION_LIMIT')
  }

  await recordExternalSnapshot({ integrationId:'tiktok', dataset:'ads_performance', periodStart:startDate, periodEnd:endDate, payload:{ rows } })
  await setIntegrationState({ id:'tiktok', state:'ready', success:true, enabled:true, metadata:{ lastRange:{startDate,endDate}, rows:rows.length } })
  return { rows: rows.length }
}
