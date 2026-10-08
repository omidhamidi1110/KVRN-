export type AiCapabilityStatus = 'ready' | 'configured_off' | 'needs_connection' | 'blocked_pending_merge'

export type AiCapability = {
  id: string
  department: string
  label: string
  status: AiCapabilityStatus
  note: string
}

const yes = (v: string | undefined) => Boolean(v?.trim())

export function getAiVideoMaxSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_VIDEO_MAX_SECONDS ?? 300)
  if (!Number.isFinite(raw)) return 300
  // Even a bad environment edit cannot expand one paid analysis beyond ten minutes.
  return Math.max(1, Math.min(600, Math.floor(raw)))
}


/**
 * Central media-URI policy. Keep provider host details inside the AI boundary so Admin/UI
 * code cannot silently grow a second provider integration path.
 */
export function validateAiVideoUri(raw: string): URL {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error('AI_VIDEO_URI_NOT_ALLOWED') }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new Error('AI_VIDEO_URI_NOT_ALLOWED')
  }
  const h = u.hostname.toLowerCase()
  const videoId = (value: string | null | undefined): string | null => {
    const id = String(value ?? '').trim()
    return /^[A-Za-z0-9_-]{6,24}$/.test(id) ? id : null
  }

  if (h === 'youtu.be') {
    const id = videoId(u.pathname.split('/').filter(Boolean)[0])
    if (!id) throw new Error('AI_VIDEO_URI_NOT_ALLOWED')
    return new URL(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`)
  }
  if (h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com') {
    let id: string | null = null
    if (u.pathname === '/watch') id = videoId(u.searchParams.get('v'))
    else {
      const parts = u.pathname.split('/').filter(Boolean)
      if (['shorts','embed','live'].includes(parts[0] ?? '')) id = videoId(parts[1])
    }
    if (!id) throw new Error('AI_VIDEO_URI_NOT_ALLOWED')
    // Strip unrelated/share tracking query parameters before the URI enters an event.
    return new URL(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`)
  }
  if (h === 'generativelanguage.googleapis.com' && /^\/v1(?:beta)?\/files\/[A-Za-z0-9_-]+$/.test(u.pathname)) {
    if (u.search || u.hash) throw new Error('AI_VIDEO_URI_NOT_ALLOWED')
    return new URL(`https://generativelanguage.googleapis.com${u.pathname}`)
  }
  throw new Error('AI_VIDEO_URI_NOT_ALLOWED')
}

/** No secret values leave this module; only boolean readiness is exposed to Admin. */
export function getAiCapabilities(env: NodeJS.ProcessEnv = process.env): AiCapability[] {
  const gatewayStoredKeys = env.AI_GATEWAY_USE_STORED_KEYS === 'true' && yes(env.CLOUDFLARE_AI_GATEWAY_TOKEN)
  const declaredExternalCapUsd = Number(env.AI_EXTERNAL_BUDGET_CAP_USD)
  const externalBudgetCapConfirmed = env.AI_EXTERNAL_BUDGET_CAP_CONFIRMED === 'true'
    && Number.isFinite(declaredExternalCapUsd) && declaredExternalCapUsd > 0 && declaredExternalCapUsd <= 5
  const inferenceEnabled = env.AI_ENABLED === 'true' && externalBudgetCapConfirmed
  // In preferred production mode provider keys live in Cloudflare AI Gateway, not KVRN.
  // Presence here means the route is configured; the manual eval arena is the proof that
  // the provider-side stored key itself is valid before autonomy is expanded.
  const anthropic = yes(env.AI_ANTHROPIC_BASE_URL) && (gatewayStoredKeys || yes(env.ANTHROPIC_API_KEY))
  const openai = yes(env.AI_OPENAI_BASE_URL) && (gatewayStoredKeys || yes(env.OPENAI_API_KEY))
  const googleAi = yes(env.AI_GOOGLE_BASE_URL) && (gatewayStoredKeys || yes(env.GOOGLE_AI_API_KEY))
  const googleOauth = yes(env.GOOGLE_OAUTH_CLIENT_ID) && yes(env.GOOGLE_OAUTH_CLIENT_SECRET) && yes(env.GOOGLE_OAUTH_REFRESH_TOKEN)
  const gsc = yes(env.GOOGLE_SEARCH_CONSOLE_SITE_URL) && (yes(env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN) || googleOauth)
  const merchant = yes(env.GOOGLE_MERCHANT_ACCOUNT_ID) && (yes(env.GOOGLE_MERCHANT_ACCESS_TOKEN) || googleOauth)
  const meta = yes(env.META_ACCESS_TOKEN) && yes(env.META_AD_ACCOUNT_ID) && yes(env.META_GRAPH_API_VERSION)
  const tiktok = yes(env.TIKTOK_ACCESS_TOKEN) && yes(env.TIKTOK_ADVERTISER_ID)
  return [
    { id: 'chief_pushover', department: 'chief', label: 'Chief daily Pushover', status: yes(env.PUSHOVER_USER_KEY) && yes(env.PUSHOVER_API_TOKEN) ? 'ready' : 'needs_connection', note: 'Guaranteed daily executive brief plus important exception alerts.' },
    { id: 'external_ai_budget_cap', department: 'chief', label: 'External AI hard budget cap', status: externalBudgetCapConfirmed ? 'ready' : 'configured_off', note: externalBudgetCapConfirmed ? `Owner-confirmed external hard cap is active at $${declaredExternalCapUsd.toFixed(2)} or less.` : 'Paid production inference remains fail-closed until an external hard cap of $5 or less is configured, declared, tested, and explicitly confirmed.' },
    { id: 'cheap_inference', department: 'chief', label: 'Cheap worker model', status: anthropic ? (inferenceEnabled ? 'ready' : 'configured_off') : 'needs_connection', note: gatewayStoredKeys ? 'Routine classification/support triage routed through Gateway stored keys; verify with the eval arena before expanding autonomy.' : 'Routine classification and support triage.' },
    { id: 'business_inference', department: 'growth_cro', label: 'Business reasoning', status: anthropic ? (inferenceEnabled ? 'ready' : 'configured_off') : 'needs_connection', note: gatewayStoredKeys ? 'CRO/market reasoning routed through Gateway stored keys; verify before expanding autonomy.' : 'CRO/market diagnosis only when thresholds justify paid inference.' },
    { id: 'video_inference', department: 'ads_social', label: 'Video intelligence', status: googleAi ? (inferenceEnabled ? 'ready' : 'configured_off') : 'needs_connection', note: gatewayStoredKeys ? 'Video analysis routed through Gateway stored keys; verify with a controlled clip before use.' : 'TikTok/Reels video analysis when source media is available.' },
    { id: 'finance_inference', department: 'finance_risk', label: 'Finance reasoning', status: openai ? (inferenceEnabled ? 'ready' : 'configured_off') : 'needs_connection', note: gatewayStoredKeys ? 'Finance reasoning routed through Gateway stored keys; canonical financial math remains deterministic.' : 'Interpretation only; canonical financial math remains deterministic.' },
    { id: 'meta', department: 'ads_social', label: 'Meta Ads/Instagram data', status: meta ? (env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? 'ready' : 'configured_off') : 'needs_connection', note: 'External connection required for live paid/organic metrics.' },
    { id: 'tiktok', department: 'ads_social', label: 'TikTok Business data', status: tiktok ? (env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? 'ready' : 'configured_off') : 'needs_connection', note: 'External connection/approved API access required.' },
    { id: 'google_search_console', department: 'seo_commerce_data', label: 'Google Search Console', status: gsc ? (env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? 'ready' : 'configured_off') : 'needs_connection', note: 'OAuth connection required for search-performance data.' },
    { id: 'google_merchant', department: 'seo_commerce_data', label: 'Google Merchant Center', status: merchant ? (env.AI_EXTERNAL_SYNC_ENABLED === 'true' ? 'ready' : 'configured_off') : 'needs_connection', note: 'OAuth/account connection required for product issues and performance.' },
    { id: 'support_reply', department: 'support', label: 'Autonomous support replies', status: 'blocked_pending_merge', note: 'Intentionally blocked until Claude policy/CMS changes are merged and canonical policy tools are verified.' },
    { id: 'review_growth', department: 'lifecycle', label: 'Native review automation', status: 'blocked_pending_merge', note: 'Waiting for the final native review schema/UI so AI never creates a competing review system.' },
    { id: 'creator_outreach', department: 'creator_affiliate', label: 'Creator outreach', status: 'needs_connection', note: 'Requires approved platform messaging/contact channels before sending anything.' },
  ]
}
