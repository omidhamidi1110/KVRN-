import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getAiBudgetSnapshot } from '@/lib/ai/budget'
import { getAiAdminOverview, getAiRuntimeSettings, listAiActions, listAiAgentPerformance, listAiAlerts, listAiApprovals } from '@/lib/ai/repository'
import { sql } from '@/lib/db'
import { getAiCapabilities } from '@/lib/ai/capabilities'
import { listIntegrationStates } from '@/lib/ai/integrations/repository'
import { listAiEvalOverview } from '@/lib/ai/evals'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try {
    const [overview, budget, actions, approvals, alerts, performance, qaFeatures, qaRuns, briefRows, settings, integrations, marketTargets, supplyProfiles, socialAnalyses, evals] = await Promise.all([
      getAiAdminOverview(),
      getAiBudgetSnapshot(),
      listAiActions(50),
      listAiApprovals(50),
      listAiAlerts(50),
      listAiAgentPerformance(30),
      sql`
        SELECT f.id, f.name, f.area, f.criticality, f.enabled, f.production_safe,
               f.last_passed_at, f.last_failed_at,
               COUNT(tc.id) FILTER (WHERE tc.enabled)::int AS test_count
        FROM qa_features f LEFT JOIN qa_test_cases tc ON tc.feature_id=f.id
        GROUP BY f.id ORDER BY
          CASE f.criticality WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
          f.area, f.name
      `,
      sql`
        SELECT id, trigger_type, environment, commit_sha, status, total_count, passed_count,
               failed_count, skipped_count, started_at, completed_at
        FROM qa_test_runs ORDER BY started_at DESC LIMIT 10
      `,
      sql`
        SELECT business_date, timezone, summary, pushover_status, generated_at, sent_at,
               model_used, model_cost_micros
        FROM ai_daily_briefs ORDER BY business_date DESC LIMIT 1
      `,
      getAiRuntimeSettings(),
      listIntegrationStates(),
      sql`SELECT t.id::text,t.name,t.target_type,t.canonical_url,t.marketplace,t.active,t.priority,t.updated_at, MAX(o.observed_at) AS last_observed_at, COUNT(o.id)::int AS observation_count FROM ai_market_targets t LEFT JOIN ai_market_observations o ON o.target_id=t.id GROUP BY t.id ORDER BY t.active DESC,t.priority ASC,t.name`,
      sql`SELECT pv.id::text AS variant_id,p.name AS product_name,pv.sku,pv.color_name,pv.size,sp.supplier_name,sp.lead_time_days,sp.safety_buffer_days,sp.target_cover_days,sp.moq_units,sp.planning_unit_quote_cents,COALESCE(sp.active,FALSE) AS profile_active FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN ai_supply_profiles sp ON sp.variant_id=pv.id WHERE pv.active=TRUE ORDER BY p.name,pv.color_name,pv.size_sort`,
      sql`SELECT id::text,platform,content_id,content_kind,captured_at,metrics FROM ai_social_snapshots WHERE source='ai_video_analysis' ORDER BY captured_at DESC LIMIT 25`,
      listAiEvalOverview(),
    ])
    return NextResponse.json({
      overview, budget, actions, approvals, alerts, performance,
      qaDetail: { features: qaFeatures, runs: qaRuns },
      capabilities: getAiCapabilities(), integrations, marketTargets, supplyProfiles, socialAnalyses, evals, latestBrief: (briefRows as any[])[0] ?? null, settings,
    })
  } catch (err: any) {
    console.error('[admin-ai] overview failed:', String(err?.message ?? err).slice(0, 100))
    return NextResponse.json({ error: 'Failed to load AI operations.' }, { status: 500 })
  }
}
