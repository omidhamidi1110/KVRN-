/**
 * Owner-run, staging-only, READ-ONLY SEO review. No Google/provider APIs.
 * KVRN_QA_STAGING_URL=https://<staging-host> node scripts/staging-seo-audit.mjs
 * Rejects production as the fetch destination. No redirects are followed.
 */
import {auditRenderedPage,auditRobotsTxt,auditSitemap} from './staging-seo-rules.mjs'
const raw = process.env.KVRN_QA_STAGING_URL ?? ''
if (!raw) { console.error('Provide KVRN_QA_STAGING_URL (private staging host); nothing requested.'); process.exit(2) }
let base
try {base=new URL(raw)} catch {console.error('Invalid staging URL.');process.exit(2)}
const isProduction = host => host==='kvrn.shop' || host.endsWith('.kvrn.shop')
const local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname)
if ((base.protocol!=='https:' && !(base.protocol==='http:'&&local)) ||
    isProduction(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname!=='/' ||
    (base.port && !local && base.port!=='443')){
  console.error('Refusing unsafe, production, or non-root staging URL. No requests made.');process.exit(2)
}
const paths=['/','/shop','/privacy','/terms','/cookies','/support/shipping-returns','/support/faq','/support/track','/robots.txt','/sitemap.xml']
const issues=[],details=[]
const fetchReadOnly=async path => {
  // The path is author-controlled or must be product slug validated by the XML auditor.
  const url=new URL(path,base)
  if(url.origin!==base.origin)throw Error('refused_cross_origin')
  return fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Accept:'text/html,application/xml,text/plain'}})
}
let productPaths=[]
async function check(path){
  let res
  try {res=await fetchReadOnly(path)} catch {issues.push(`${path}:unavailable`);return}
  if(res.status!==200) {
    issues.push(`${path}:HTTP_${res.status}`)
    details.push({path,status:res.status,...(res.status>=300&&res.status<400?{redirectRequiresReview:true}:{})})
    return
  }
  const len=Number(res.headers.get('content-length'))
  if(Number.isFinite(len)&&len>2_000_000){issues.push(`${path}:response_too_large`);return}
  let content
  try {content=(await res.text()).slice(0,2_000_001)} catch {issues.push(`${path}:unreadable`);return}
  if(content.length>2_000_000){issues.push(`${path}:response_too_large`);return}
  const report=path==='/robots.txt'?auditRobotsTxt(content):path==='/sitemap.xml'?auditSitemap(content):auditRenderedPage(path,content,{xRobotsTag:res.headers.get('x-robots-tag')??''})
  issues.push(...report.issues.map(code=>`${path}:${code}`))
  details.push({path,status:res.status,...(path==='/sitemap.xml'?{listedUrls:report.count}:{}),
    ...('title' in report?{title:report.title,canonical:report.canonical,noindex:report.noindex}:{})})
  if(path==='/sitemap.xml')productPaths=report.productPaths.slice(0,3)
}
for(const path of paths)await check(path)
for(const path of productPaths)await check(path)
console.log(JSON.stringify({stagingOrigin:base.origin,checked:details.length,issues,details},null,2))
if(issues.length)process.exitCode=1
