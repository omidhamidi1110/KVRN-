import {type NextRequest,NextResponse} from 'next/server'
import {requireAdmin} from '@/lib/admin-auth'
import {getPrivateInsight,validateInsightTopic} from '@/lib/ai/private-insights'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
export async function GET(req:NextRequest){
 const {error}=await requireAdmin(req);if(error)return error
 if(req.nextUrl.search.length>90)return NextResponse.json({error:'Invalid query.'},{status:400,headers})
 const topic=req.nextUrl.searchParams.get('topic')
 if(!validateInsightTopic(topic)||[...req.nextUrl.searchParams.keys()].some(x=>x!=='topic')||req.nextUrl.searchParams.getAll('topic').length!==1)
  return NextResponse.json({error:'Unsupported private insight.'},{status:400,headers})
 try{return NextResponse.json(await getPrivateInsight(topic),{headers})}
 catch{return NextResponse.json({error:'Insight unavailable. Missing or inconsistent data; do not assume zero.'},{status:503,headers})}
}
