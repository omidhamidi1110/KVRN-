import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { listAiEvalOverview, runSupportTriageEvaluation } from '@/lib/ai/evals'
import { sql } from '@/lib/db'
import type { AiEvaluationModelId } from '@/lib/ai/types'

export const dynamic = 'force-dynamic'
const MODELS = new Set<AiEvaluationModelId>(['haiku_5_5','gpt_6_luna'])

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  try { return NextResponse.json(await listAiEvalOverview()) }
  catch { return NextResponse.json({ error:'Failed to load AI evaluations.' }, { status:500 }) }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  let body:any
  try { body=await req.json() } catch { return NextResponse.json({ error:'Invalid JSON.' },{status:400}) }
  const suite=String(body?.suite ?? 'support_triage')
  const modelId=String(body?.evaluationModelId ?? '') as AiEvaluationModelId
  const requestedCases=Number(body?.maxCases ?? 10)
  const maxCases=Number.isFinite(requestedCases) ? Math.max(1,Math.min(20,Math.floor(requestedCases))) : 10
  if (suite!=='support_triage') return NextResponse.json({ error:'Unsupported evaluation suite.' },{status:400})
  if (!MODELS.has(modelId)) return NextResponse.json({ error:'Unsupported evaluation model.' },{status:400})
  try {
    const result=await runSupportTriageEvaluation({evaluationModelId:modelId,maxCases})
    await sql`
      INSERT INTO admin_audit_logs(actor_email,action,resource,resource_id,payload)
      VALUES (${identity.email},'ai_eval_run','ai_eval_run',${result.runId},${JSON.stringify({suite,modelId,maxCases,status:result.status,score:result.score})}::jsonb)
    `
    return NextResponse.json({ok:true,...result})
  } catch (err:any) {
    return NextResponse.json({ error:String(err?.message ?? 'AI evaluation failed.').slice(0,140) },{status:409})
  }
}
